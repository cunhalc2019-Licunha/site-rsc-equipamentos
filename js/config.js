// Configuração da loja — edite aqui.
window.RSC_CONFIG = {
  // Número do WhatsApp (DDI + DDD + número, só dígitos)
  whatsapp: "5511957357190",

  // Como o checkout finaliza o pedido:
  //  "whatsapp"    → modo demonstração: o pedido completo é enviado ao WhatsApp da loja
  //  "mercadopago" → pagamento online real (PIX, cartão até 12x, boleto) via /api/checkout
  //                  Requer o site publicado na Vercel com a variável MP_ACCESS_TOKEN.
  paymentProvider: "whatsapp",

  checkoutEndpoint: "/api/checkout",
  maxInstallments: 12,
};
