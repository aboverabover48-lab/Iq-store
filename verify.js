// Vercel serverless funksiya: to'lov chekini Gemini orqali tekshiradi.
// Vercel -> Settings -> Environment Variables: GEMINI_API_KEY (majburiy), GEMINI_MODEL (ixtiyoriy)
const PRICE = 10000;            // faqat shu summa qabul qilinadi (so'm)
const CARD_LAST4 = '2486';      // karta oxirgi 4 raqami
const NAME = /g.?aybullayev|og.?abek/i;

const PROMPT = `Siz toʻlov chekini tekshiruvchisiz. Rasmni diqqat bilan oʻqing va FAQAT JSON qaytaring:
{"is_receipt":true/false,"amount":son yoki null,"card_last4":"4 raqam yoki null","recipient":"qabul qiluvchi ismi yoki null","date":"YYYY-MM-DD yoki null","edited_or_fake":true/false,"reason":"qisqa izoh"}
is_receipt faqat haqiqiy bank/ilova toʻlov cheki yoki toʻlov skrinshoti boʻlsa true. Boshqa rasm (selfi, mem, oddiy matn, oʻyin, manzara va h.k.) boʻlsa false.
amount — soʻmda, boʻshliqsiz son. edited_or_fake — rasm tahrirlangan, AI yaratgan, qirqilgan yoki shubhali boʻlsa true (shrift, tekislik, rang nomuvofiqligi va h.k.).`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ reason: 'Faqat POST.' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ reason: 'Server sozlanmagan (GEMINI_API_KEY yoʻq).' });
  try {
    const m = String(req.body && req.body.img || '').match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return res.status(400).json({ reason: 'Rasm notoʻgʻri.' });
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) return res.status(502).json({ reason: 'AI xizmati javob bermadi. Birozdan soʻng qayta urinib koʻring.' });
    const j = await r.json();
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
    const a = JSON.parse(String((txt && txt[0] && txt[0].text) || '{}').replace(/```json|```/g, ''));

    // Yakuniy qaror KODDA qabul qilinadi (AI ga ishonilmaydi)
    if (!a.is_receipt) return res.json({ reason: 'Bu toʻlov cheki emas. Toʻlov chekining rasmini yuklang.' });
    if (Number(a.amount) !== PRICE) return res.json({ reason: `Toʻlov summasi roppa-rosa ${PRICE.toLocaleString('ru-RU')} soʻm boʻlishi kerak.` });
    if (String(a.card_last4) !== CARD_LAST4 && !NAME.test(a.recipient || '')) return res.json({ reason: 'Toʻlov koʻrsatilgan kartaga qilinmagan.' });
    if (a.edited_or_fake) return res.json({ reason: 'Chek shubhali koʻrindi. Asl chekni yuklang.' });
    const d = Date.parse(a.date);
    if (d && Date.now() - d > 3 * 864e5) return res.json({ reason: 'Chek juda eski. Yangi toʻlov qiling.' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ reason: 'Tekshirishda xatolik. Qayta urinib koʻring.' });
  }
};
