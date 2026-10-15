// Serviço central de estoque. TODA alteração de saldo passa por `move`, dentro de uma transação:
// trava a linha do saldo (SELECT ... FOR UPDATE), valida, atualiza e grava o histórico.
//
// Modelo:  físico (on_hand) | reservado (reserved) | disponível = físico − reservado | vendido (sold)
//
// Transições (físico Δ / reservado Δ / vendido Δ):
//   entrada            +q /  0 /  0
//   venda_fisica       −q /  0 / +q   (só consome o DISPONÍVEL — nunca uma unidade reservada)
//   reserva_criada      0 / +q /  0   (pedido online criado; não mexe no físico)
//   reserva_liberada    0 / −q /  0   (expirou ou foi cancelada)
//   venda_online       −q / −q / +q   (pagamento confirmado: a reserva vira venda — a baixa acontece UMA vez)
//   venda_online*      −q /  0 / +q   (*pagamento tardio sem reserva ativa, se ainda houver disponível)
//   ajuste             ±q /  0 /  0   (motivo obrigatório)
//   estorno            +q /  0 / −q   (devolução ao estoque após estorno antes da entrega)
//   cancelamento       +q /  0 / −q   (venda física desfeita)
import { fail } from "./http.js";

export const ENTRY_ORIGINS = {
  compra: "Compra de equipamento", troca: "Recebido em troca", devolucao: "Devolução de cliente",
  estoque_inicial: "Estoque inicial", fornecedor: "Reposição de fornecedor", outro: "Outro",
};
export const ADJUST_REASONS = { inventario: "Contagem de inventário", correcao: "Correção de lançamento", perda: "Perda / avaria", uso_interno: "Uso interno" };

export async function lockInventory(t, storeId, productIds) {
  const ids = [...new Set(productIds)].sort();
  const rows = await t.query(
    `SELECT i.product_id, i.on_hand, i.reserved, i.sold, p.stock_type, p.name, p.sku, p.state
       FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = ANY($1::uuid[]) AND i.store_id = $2
      ORDER BY i.product_id
      FOR UPDATE OF i`, [ids, storeId]);
  if (rows.length !== ids.length) fail(404, "Produto não encontrado.");
  return Object.fromEntries(rows.map(r => [r.product_id, r]));
}

// m: { storeId, inv (linha travada), type, quantity, physicalDelta, reservedDelta, soldDelta,
//      reason, userId, orderId, reservationId, origin, note, unitCostCents, supplier, document, movementDate }
export async function move(t, m) {
  const inv = m.inv;
  const pd = m.physicalDelta || 0, rd = m.reservedDelta || 0, sd = m.soldDelta || 0;
  const onHand = inv.on_hand + pd, reserved = inv.reserved + rd, sold = inv.sold + sd;
  if (onHand < 0) fail(422, `Estoque insuficiente de "${inv.name}" (físico: ${inv.on_hand}).`, { code: "INSUFFICIENT_STOCK" });
  if (reserved < 0) fail(409, `Reserva inconsistente para "${inv.name}".`);
  if (reserved > onHand) fail(409, `"${inv.name}" tem ${inv.reserved} unidade(s) reservada(s) por pedido online — essa quantidade não pode ser usada.`, { code: "RESERVED" });
  if (inv.stock_type === "unico" && onHand > 1) fail(422, `"${inv.name}" é um produto único: o estoque físico máximo é 1.`);
  if (sold < 0) fail(409, "Quantidade vendida inconsistente.");

  await t.query("UPDATE inventory SET on_hand = $2, reserved = $3, sold = $4, updated_at = now() WHERE product_id = $1",
    [inv.product_id, onHand, reserved, sold]);
  const [row] = await t.query(
    `INSERT INTO stock_movements (store_id, product_id, type, quantity, physical_delta, reserved_delta,
        physical_before, physical_after, reserved_before, reserved_after, reason, unit_cost_cents, supplier, document,
        note, user_id, order_id, reservation_id, origin, movement_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, created_at`,
    [m.storeId, inv.product_id, m.type, m.quantity, pd, rd, inv.on_hand, onHand, inv.reserved, reserved,
     m.reason || m.type, m.unitCostCents ?? null, m.supplier ?? null, m.document ?? null, m.note ?? null,
     m.userId ?? null, m.orderId ?? null, m.reservationId ?? null, m.origin || "painel", m.movementDate ?? null]);
  // mantém a linha travada coerente para chamadas seguintes na mesma transação
  inv.on_hand = onHand; inv.reserved = reserved; inv.sold = sold;
  return { ...row, physical_before: onHand - pd, physical_after: onHand, reserved_after: reserved, available: onHand - reserved };
}

export const available = inv => inv.on_hand - inv.reserved;
