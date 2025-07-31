wppconnect.create({
  session: 'cipt-session',
  headless: true,
  useChrome: false,
  browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
  puppeteerOptions: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  catchQR: (base64Qr, asciiQR) => {
    console.log('⚡ QRCode recebido (ASCII):');
    console.log(asciiQR); // Mostra no terminal
    require('fs').writeFileSync('qrcode.html', `<img src="${base64Qr}">`);
    console.log('⚡ Abra o arquivo qrcode.html para escanear com o WhatsApp');
  },
  tokenStore: 'file',
})
