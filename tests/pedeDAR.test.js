const assert = require('assert');

const regexDAR = /\b(dar(?:s)?|boleto|2.?ª? via|segunda via|guia(?: de pagamento)?|pagamento (?:do aluguel|de eventos)|pagamento)\b/i;
const regexVencidas = /vencid|atrasad|pendent/i;
const regexVigente = /vigent|atual|corrente|m[eê]s/i;

const darSynonyms = [
  'dar',
  'dars',
  'boleto',
  '2 via',
  '2ª via',
  'segunda via',
  'guia',
  'guia de pagamento',
  'pagamento do aluguel',
  'pagamento de eventos',
  'pagamento'
];

darSynonyms.forEach((text) => {
  assert(regexDAR.test(text.toLowerCase()), `Failed to match DAR synonym: ${text}`);
});

// Ensure conjunction with pedeVencidas and pedeVigente
assert(regexDAR.test('pagamento vencido') && regexVencidas.test('pagamento vencido'), 'pedeDAR with vencidas');
assert(regexDAR.test('guia vigente') && regexVigente.test('guia vigente'), 'pedeDAR with vigente');

console.log('All pedeDAR regex tests passed');
