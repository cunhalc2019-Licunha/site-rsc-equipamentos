// Webhook do Mercado Pago — recebe avisos de pagamento (aprovado, pendente, recusado).
// Configure a mesma URL em: Mercado Pago > Suas integrações > Webhooks > /api/webhook
// Aqui o pagamento é consultado direto na API do Mercado Pago (fonte confiável) e registrado nos logs.
// Próximo passo comum: enviar e-mail/WhatsApp para a loja ou salvar o pedido em um banco de dados.
export default async function handler(req, res) {
  const id = req.body?.data?.id || req.query?.["data.id"] || req.query?.id;
  const type = req.body?.type || req.query?.type || req.query?.topic;
  if (type !== "payment" || !id) return res.status(200).end();

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) return res.status(200).end();
  const p = await r.json();

  console.log("[pedido]", p.external_reference, p.status, p.payment_type_id, p.transaction_amount,
    p.payer?.email, JSON.stringify(p.metadata || {}));

  return res.status(200).end();
}
