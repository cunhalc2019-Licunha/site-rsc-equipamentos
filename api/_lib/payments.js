// Estrutura de pagamentos para a ETAPA 3 (Mercado Pago). Nesta etapa NÃO existe confirmação real:
// nenhuma rota pública ou do painel chama `applyPaymentStatus` — só a futura integração (webhook que
// CONSULTA o estado real na API do provedor) e os testes automatizados controlados.
//
// Regras implementadas (seção 14):
//  • aprovado com reserva ativa → converte reserva em venda (baixa física única), pedido "pago".
//  • aprovado após a reserva expirar/cancelar → confere disponibilidade REAL:
//       – há disponível: vende (baixa) e registra ocorrência informativa;
//       – não há: NÃO vende, não deixa estoque negativo, registra ocorrência para reembolso.
//  • estornado → pedido "estornado"; se ainda não foi concluído/entregue, devolve ao estoque (movimento "estorno").
//  • recusado/cancelado/pendente → só registra; a reserva segue até expirar.
//  • eventos repetidos do provedor são ignorados (payment_events único por provider+event_id).
import { fail } from "./http.js";
import { lockInventory, move, available } from "./stock.js";

const STATUSES = ["pendente", "aprovado", "recusado", "cancelado", "estornado", "desconhecido"];

export async function recordEvent(t, provider, eventId, payload) {
  const rows = await t.query(
    `INSERT INTO payment_events (provider, event_id, payload) VALUES ($1,$2,$3)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [provider, eventId, JSON.stringify(payload || {})]);
  return rows.length > 0; // false = evento duplicado
}

export async function applyPaymentStatus(t, { orderId, provider, externalId, status, amountCents, method, raw }) {
  if (!STATUSES.includes(status)) fail(422, "Status de pagamento inválido.");
  if (provider === "teste" && process.env.NODE_ENV !== "test") fail(403, "Provedor de teste só é aceito nos testes automatizados.");
  const [order] = await t.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  if (!order) fail(404, "Pedido não encontrado.");
  if (order.channel !== "online") fail(422, "Pagamentos online só se aplicam a pedidos online.");

  await t.query(
    `INSERT INTO payments (store_id, order_id, provider, external_id, status, method, amount_cents, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, external_id) DO UPDATE SET status = EXCLUDED.status, raw = EXCLUDED.raw, updated_at = now()`,
    [order.store_id, orderId, provider, externalId, status, method || null, amountCents ?? null, JSON.stringify(raw || {})]);

  if (status === "aprovado") return approve(t, order, amountCents);
  if (status === "estornado") return refund(t, order);
  if (order.payment_status !== "aprovado") {
    await t.query("UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1", [orderId, status]);
  }
  return { result: "registrado" };
}

async function issue(t, order, type, description) {
  await t.query("INSERT INTO order_issues (store_id, order_id, type, description) VALUES ($1,$2,$3,$4)", [order.store_id, order.id, type, description]);
}

async function approve(t, order, amountCents) {
  if (order.payment_status === "aprovado") return { result: "ja_aprovado" }; // idempotente
  if (amountCents != null && amountCents !== order.total_cents) {
    await issue(t, order, "valor_divergente", `Pagamento aprovado de ${amountCents} centavos difere do total do pedido (${order.total_cents}).`);
  }
  const items = await t.query("SELECT oi.*, r.id AS reservation_id, r.status AS reservation_status, r.quantity AS reserved_qty FROM order_items oi LEFT JOIN reservations r ON r.order_item_id = oi.id WHERE oi.order_id = $1", [order.id]);
  const invs = await lockInventory(t, order.store_id, items.map(i => i.product_id));

  const late = items.some(i => i.reservation_status !== "ativa");
  if (late) {
    // Pagamento tardio: só confirma se TODAS as unidades sem reserva ativa ainda estiverem disponíveis.
    const missing = items.filter(i => i.reservation_status !== "ativa" && available(invs[i.product_id]) < i.quantity);
    if (missing.length) {
      await t.query("UPDATE orders SET payment_status = 'aprovado', updated_at = now() WHERE id = $1", [order.id]);
      await issue(t, order, "pagamento_apos_expiracao_sem_estoque",
        `Pagamento aprovado após a reserva expirar, mas ${missing.map(m => `"${m.name}"`).join(", ")} já não está disponível. Venda NÃO confirmada — providenciar reembolso ao cliente.`);
      return { result: "conflito_sem_estoque" };
    }
  }

  for (const i of items) {
    const inv = invs[i.product_id];
    if (i.reservation_status === "ativa") {
      await t.query("UPDATE reservations SET status = 'convertida', released_at = now(), release_reason = 'pagamento_aprovado' WHERE id = $1", [i.reservation_id]);
      await move(t, { storeId: order.store_id, inv, type: "venda_online", quantity: i.quantity, physicalDelta: -i.quantity,
        reservedDelta: -i.quantity, soldDelta: i.quantity, reason: "pagamento_aprovado", orderId: order.id, reservationId: i.reservation_id, origin: "pagamento" });
    } else {
      await move(t, { storeId: order.store_id, inv, type: "venda_online", quantity: i.quantity, physicalDelta: -i.quantity,
        soldDelta: i.quantity, reason: "pagamento_tardio", note: "Pagamento confirmado após a reserva expirar; havia disponibilidade.", orderId: order.id, origin: "pagamento" });
    }
  }
  await t.query("UPDATE orders SET status = 'pago', payment_status = 'aprovado', updated_at = now() WHERE id = $1", [order.id]);
  if (late) await issue(t, order, "pagamento_tardio_confirmado", "Pagamento confirmado após o vencimento da reserva. Havia estoque disponível e a venda foi registrada.");
  return { result: late ? "aprovado_tardio" : "aprovado" };
}

async function refund(t, order) {
  if (order.status === "estornado") return { result: "ja_estornado" };
  const sold = order.payment_status === "aprovado" && ["pago", "em_processamento"].includes(order.status);
  if (sold) {
    const items = await t.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
    const invs = await lockInventory(t, order.store_id, items.map(i => i.product_id));
    for (const i of items) {
      await move(t, { storeId: order.store_id, inv: invs[i.product_id], type: "estorno", quantity: i.quantity, physicalDelta: i.quantity,
        soldDelta: -i.quantity, reason: "estorno_antes_da_entrega", orderId: order.id, origin: "pagamento" });
    }
  } else if (order.status === "concluido") {
    await issue(t, order, "estorno_apos_entrega", "Pagamento estornado após o pedido ser concluído. Avaliar devolução do equipamento antes de repor o estoque.");
  }
  await t.query("UPDATE orders SET status = 'estornado', payment_status = 'estornado', updated_at = now() WHERE id = $1", [order.id]);
  return { result: "estornado" };
}
