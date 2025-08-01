const fs = require('fs');
const CryptoJS = require('crypto-js');

const PASSWORD = process.env.AUTH_BACKUP_KEY;

try {
  const encrypted = fs.readFileSync('auth-backup.enc', 'utf8');
  const decrypted = CryptoJS.AES.decrypt(encrypted, PASSWORD).toString(CryptoJS.enc.Utf8);
  const zipData = Buffer.from(decrypted, 'base64');
  fs.writeFileSync('auth-restored.zip', zipData);
  console.log('✅ Backup restaurado em auth-restored.zip');
} catch (err) {
  console.error('❌ Erro ao restaurar:', err);
}