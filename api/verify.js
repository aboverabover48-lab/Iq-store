const crypto = require('crypto');

const PRICE = 10000;
const CARD_LAST4 = '2486';
const NAME = /g.?aybullayev|og.?abek/i;

const PROMPT = 'Siz tolov chekini tekshiruvchisiz. Rasmni diqqat bilan oqing va FAQAT JSON qaytaring: {"is_receipt":true/false,"amount":son yoki null,"card_last4":"4 raqam yoki null","recipient":"qabul qiluvchi ismi yoki null","date":"YYYY-MM-DD yoki null","time":"HH:MM yoki HH:MM:SS yoki null","tx_id":"tranzaksiya yoki chek raqami yoki null","edited_or_fake":true/false,"reason":"qisqa izoh"}. is_receipt faqat haqiqiy bank/ilova tolov cheki yoki tolov skrinshoti bolsa true. Boshqa rasm bolsa false. amount — somda, boshliqsiz son. tx_id — chekdagi unikal tranzaksiya/kvitansiya raqami (bolsa). edited_or_fake — rasm tahrirlangan, AI yaratgan, qirqilgan yoki shubhali bolsa true.';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ reason: 'Faqat POST.' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ reason: 'Server sozlanmagan (GEMINI_API_KEY yoq).' });

  try {
    const imgStr = String((req.body && req.body.img) || '');
    const matchPos = imgStr.indexOf(';base64,');
    if (!imgStr.startsWith('data:image/') || matchPos === -1) {
      return res.status(400).json({ reason: 'Rasm notogri.' });
    }

    const mimeType = imgStr.slice(5, matchPos);
    const base64Data = imgStr.slice(matchPos + 8);
    const imgHash = crypto.createHash('sha256').update(base64Data).digest('hex');

    const rawUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
    const rawToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    const redisUrl = rawUrl.replace(/^["'\s]+|["'\s]+$/g, '');
    const redisToken = rawToken.replace(/^["'\s]+|["'\s]+$/g, '');

    if (redisUrl && redisToken) {
      const imgCheck = await fetch(redisUrl + '/get/img_' + imgHash, {
        headers: { Authorization: 'Bearer ' + redisToken }
      });
      const imgData = await imgCheck.json();
      if (imgData && imgData.result) {
        return res.json({ reason: 'Bu chek rasmi allaqachon ishlatilgan! Yangi tolov qiling.' });
      }
    }

    const model = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
    const apiUrl = 'https://googleapis.com' + model + ':generateContent';

    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });

    if (!r.ok) return res.status(502).json({ reason: 'AI xizmati javob bermadi. Birozdan song qayta urinib koring.' });
    const j = await r.json();
    const parts = (((j.candidates || []).at(0) || {}).content || {}).parts;
    const rawText = (parts && parts.at(0) && parts.at(0).text) || '{}';
    const a = JSON.parse(String(rawText).replace(/```json|```/g, ''));

    if (!a.is_receipt) return res.json({ reason: 'Bu tolov cheki emas. Tolov chekining rasmini yuklang.' });
    if (Number(a.amount) !== PRICE) return res.json({ reason: 'Tolov summasi roppa-rosa 10 000 som bolishi kerak.' });
    if (String(a.card_last4) !== CARD_LAST4 && !NAME.test(a.recipient || '')) return res.json({ reason: 'Tolov korsatilgan kartaga qilinmagan.' });
    if (a.edited_or_fake) return res.json({ reason: 'Chek shubhali korindi. Asl chekni yuklang.' });

    const d = Date.parse(a.date);
    if (d && Date.now() - d > 3 * 864e5) return res.json({ reason: 'Chek juda eski. Yangi tolov qiling.' });

    if (redisUrl && redisToken) {
      const uniqueSig = a.tx_id
        ? 'tx_' + String(a.tx_id).trim().toLowerCase()
        : 'dt_' + (a.date || 'nodate') + '_' + (a.time || 'notime') + '_' + a.amount + '_' + (a.card_last4 || '');

      const receiptKey = encodeURIComponent('rcpt_' + uniqueSig);

      const checkRes = await fetch(redisUrl + '/get/' + receiptKey, {
        headers: { Authorization: 'Bearer ' + redisToken }
      });
      const checkData = await checkRes.json();

      if (checkData && checkData.result) {
        return res.json({ reason: 'Bu tolov cheki allaqachon ishlatilgan! Yangi tolov qiling.' });
      }

      await Promise.all([
        fetch(redisUrl + '/set/img_' + imgHash + '/1?EX=2592000', {
          headers: { Authorization: 'Bearer ' + redisToken }
        }),
        fetch(redisUrl + '/set/' + receiptKey + '/1?EX=2592000', {
          headers: { Authorization: 'Bearer ' + redisToken }
        })
      ]);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ reason: 'Xatolik: ' + e.message });
  }
};
