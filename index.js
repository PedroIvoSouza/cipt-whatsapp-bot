wppconnect.create({
  session: 'cipt-session',
  headless: true,
  useChrome: false,
  browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
  puppeteerOptions: {
    executablePath: 'google-chrome-stable', // força headless
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  disableWelcome: true,
  catchQR: (base64Qr, asciiQR) => {
    console.log('⚡ QRCode recebido (ASCII):');
    console.log(asciiQR);
    require('fs').writeFileSync('qrcode.html', `<img src="${base64Qr}">`);
    console.log('⚡ QRCode salvo em qrcode.html — abra pelo Preview do Codespaces e escaneie no WhatsApp.');
  },
  tokenStore: 'file'
})
