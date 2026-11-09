const crypto = require('crypto');

const PRICE = 10000;            // faqat shu summa qabul qilinadi (so'm)
const CARD_LAST4 = '2486';      // karta oxirgi 4 raqami
const NAME = /g.?aybullayev|og.?abek/i;

const PROMPT = `Siz toʻlov chekini tekshiruvchisiz. Rasmni diqqat bilan oʻqing va FAQAT JSON qaytaring:
{"is_receipt":true/false,"amount":son yoki null,"card_last4":"4 raqam yoki null","recipient":"qabul qiluvchi ismi yoki null","date":"YYYY-MM-DD yoki null","time":"HH:MM yoki HH:MM:SS yoki null","tx_id":"tranzaksiya yoki chek raqami yoki null","edited_or_fake":true/false,"reason":"qisqa izoh"}
is_receipt faqat haqiqiy bank/ilova toʻlov cheki yoki toʻlov skrinshoti boʻlsa true. Boshqa rasm (selfi, mem, oddiy matn, oʻyin, manzara va h.k.) boʻlsa false.
amount — soʻmda, boʻshliqsiz son. tx_id — chekdagi unikal tranzaksiya/kvitansiya raqami (boʻlsa). edited_or_fake — rasm tahrirlangan, AI yaratgan, qirqilgan yoki shubhali boʻlsa true.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ reason: 'Faqat POST.' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ reason: 'Server sozlanmagan (GEMINI_API_KEY yoʻq).' });

  try {
    const imgStr = String((req.body && req.body.img) || '');
    const matchPos = imgStr.indexOf(';base64,');
    if (!imgStr.startsWith('data:image/') || matchPos === -1) {
      return res.status(400).json({ reason: 'Rasm notoʻgʻri.' });
    }

    const mimeType = imgStr.slice(5, matchPos);
    const base64Data = imgStr.slice(matchPos + 8);

    // 1. Rasm faylining unikal xeshini (barmoq izini) hisoblaymiz
    const imgHash = crypto.createHash('sha256').update(base64Data).digest('hex');

    const rawUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
    const rawToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    const redisUrl = rawUrl.replace(/^["'\s]+|["'\s]+$/g, '');
    const redisToken = rawToken.replace(/^["'\s]+|["'\s]+$/g, '');

    // Agar aynan shu rasm fayli oldin yuklangan bo'lsa, AI ga yubormasdan darhol rad etamiz
    if (redisUrl && redisToken) {
      const imgCheck = await fetch(`${redisUrl}/get/img_${imgHash}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const imgData = await imgCheck.json();
      if (imgData && imgData.result) {
        return res.json({ reason: 'Bu chek rasmi allaqachon ishlatilgan! Yangi toʻlov qiling.' });
      }
    }

    // 2. Gemini AI orqali chekni tekshiramiz
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const r = await fetch(`https://googleapis.com{model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });

    if (!r.ok) return res.status(502).json({ reason: 'AI xizmati javob bermadi. Birozdan soʻng qayta urinib koʻring.' });
    const j = await r.json();
    const parts = (((j.candidates || []).at(0) || {}).content || {}).parts;
    const rawText = (parts && parts.at(0) && parts.at(0).text) || '{}';
    const a = JSON.parse(String(rawText).replace(/```json|```/g, ''));

    // 3. Chek ma'lumotlarini qat'iy tekshirish
    if (!a.is_receipt) return res.json({ reason: 'Bu toʻlov cheki emas. Toʻlov chekining rasmini yuklang.' });
    if (Number(a.amount) !== PRICE) return res.json({ reason: `Toʻlov summasi roppa-rosa ${PRICE.toLocaleString('ru-RU')} soʻm boʻlishi kerak.` });
    if (String(a.card_last4) !== CARD_LAST4 && !NAME.test(a.recipient || '')) return res.json({ reason: 'Toʻlov koʻrsatilgan kartaga qilinmagan.' });
    if (a.edited_or_fake) return res.json({ reason: 'Chek shubhali koʻrindi. Asl chekni yuklang.' });

    const d = Date.parse(a.date);
    if (d && Date.now() - d > 3 * 864e5) return res.json({ reason: 'Chek juda eski. Yangi toʻlov qiling.' });

    // 4. Chek ma'lumotlarini (tranzaksiya ID va vaqt) Redis bazada tekshirish va saqlash
    if (redisUrl && redisToken) {
      const uniqueSig = a.tx_id
        ? `tx_${String(a.tx_id).trim().toLowerCase()}`
        : `dt_${a.date || 'nodate'}_${a.time || 'notime'}_${a.amount}_${a.card_last4 || ''}`;

      const receiptKey = encodeURIComponent(`rcpt_${uniqueSig}`);

      const checkRes = await fetch(`${redisUrl}/get/${receiptKey}`, {
        headers: { Authorization: `Bearer ${redisToken}` }
      });
      const checkData = await checkRes.json();

      if (checkData && checkData.result) {
        return res.json({ reason: 'Bu toʻlov cheki allaqachon ishlatilgan! Yangi toʻlov qiling.' });
      }

      // Ikkalasini ham (ham rasm xeshini, ham chek ma'lumotini) 30 kunga bazaga yozib qo'yamiz
      await Promise.all([
        fetch(`${redisUrl}/set/img_${imgHash}/1?EX=2592000`, {
          headers: { Authorization: `Bearer ${redisToken}` }
        }),
        fetch(`${redisUrl}/set/${receiptKey}/1?EX=2592000`, {
          headers: { Authorization: `Bearer ${redisToken}` }
        })
      ]);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ reason: `Xatolik: ${e.message}` });
  }
};
