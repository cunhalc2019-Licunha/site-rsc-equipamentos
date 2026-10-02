// Regras de estoque. Toda movimentação passa por applyMovement, dentro de uma transação:
// trava a linha do saldo, valida, atualiza o saldo e grava o histórico.
import { fail } from "./http.js";

export const REASONS = {
  entrada: { compra: "Compra de equipamento", troca: "Recebido em troca", devolucao: "Devolução de cliente", estoque_inicial: "Estoque inicial", outro: "Outro" },
  saida:   { venda_loja: "Venda na loja física", perda: "Perda / avaria", uso_interno: "Uso interno", outro: "Outro" },
  ajuste:  { inventario: "Contagem de inventário", correcao: "Correção de lançamento" },
};

export async function applyMovement(t, m) {
  if (!REASONS[m.type]?.[m.reason]) fail(422, "Motivo da movimentação inválido.");
  if (!Number.isInteger(m.quantity) || m.quantity === 0) fail(422, "Quantidade inválida.");
  if (m.type === "entrada" && m.quantity < 0) fail(422, "Entrada deve ter quantidade positiva.");
  if (m.type === "saida" && m.quantity > 0) m.quantity = -m.quantity;

  const [inv] = await t.query(
    `SELECT i.on_hand, i.reserved, p.stock_type, p.name
       FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = $1 AND i.store_id = $2
      FOR UPDATE OF i`, [m.productId, m.storeId]);
  if (!inv) fail(404, "Produto não encontrado.");

  const next = inv.on_hand + m.quantity;
  if (next < 0) fail(422, `Saldo insuficiente: há ${inv.on_hand} unidade(s) de "${inv.name}".`);
  if (next < inv.reserved) fail(422, `Não é possível: ${inv.reserved} unidade(s) estão reservadas em pedidos online.`);
  if (inv.stock_type === "unico" && next > 1) fail(422, `"${inv.name}" é um produto único: o estoque máximo é 1.`);

  await t.query("UPDATE inventory SET on_hand = $1, updated_at = now() WHERE product_id = $2", [next, m.productId]);
  const [mov] = await t.query(
    `INSERT INTO stock_movements (store_id, product_id, type, quantity, reason, unit_cost_cents, supplier, document, note, balance_after, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
    [m.storeId, m.productId, m.type, m.quantity, m.reason, m.unitCostCents ?? null, m.supplier ?? null,
     m.document ?? null, m.note ?? null, next, m.userId ?? null]);
  return { ...mov, balance_after: next };
}
