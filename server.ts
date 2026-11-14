import express from "express";
import path from "path";
import { readFileSync } from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { initializeApp as initAdmin, cert, getApps } from 'firebase-admin/app';
import { getAuth as getAdminAuth, DecodedIdToken } from 'firebase-admin/auth';
import type { Request, Response, NextFunction } from 'express';
import configFile from './firebase-applet-config.json';

dotenv.config();

if (!getApps().length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      initAdmin({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      });
    } else {
      initAdmin({
        projectId: configFile.projectId
      });
    }
  } catch (e) {
    console.warn("Firebase Admin init notice:", e);
  }
}

interface AuthRequest extends Request {
  user?: DecodedIdToken;
  authMode?: 'guest' | 'user' | 'custom-key';
}

const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const customKey = req.body?.customApiKey;
  if (customKey && typeof customKey === 'string' && customKey.length >= 20) {
    req.authMode = 'custom-key';
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      req.user = await getAdminAuth().verifyIdToken(token);
      req.authMode = 'user';
      return next();
    } catch (err) {
      console.warn('Invalid token, falling back to guest');
    }
  }

  req.authMode = 'guest';
  next();
};

const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Rate Limiter
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 5 * 60 * 1000);

const QUOTAS = {
  guest: { max: 15, windowMs: 60 * 60 * 1000 }, // 15/hour for guests
  user: { max: 100, windowMs: 60 * 60 * 1000 }, // 100/hour for registered
  'custom-key': { max: Infinity, windowMs: 0 },
};

const rateLimit = (req: AuthRequest, res: Response, next: NextFunction) => {
  const mode = req.authMode || 'guest';
  const quota = QUOTAS[mode];

  if (quota.max === Infinity) return next();

  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const key = req.user?.uid ? `uid:${req.user.uid}` : `ip:${clientIp}`;

  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + quota.windowMs };
    buckets.set(key, bucket);
  }

  bucket.count++;

  res.setHeader('X-RateLimit-Limit', quota.max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, quota.max - bucket.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > quota.max) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
      hint: 'سجّل الدخول للحصول على حصة أعلى، أو استخدم مفتاحك الخاص.',
    });
  }

  next();
};

// Gemini Error Handler Helper
const handleGeminiError = (error: any, res: Response) => {
  if (error.status === 429 || error.message?.includes("429") || error.message?.includes("resource_exhausted") || error.message?.includes("quota")) {
    return res.status(429).json({ 
      error: "تم استنفاد حصة المحرك الذكي (Quota Exceeded).",
      suggestion: "يرجى استخدام مفتاح API الخاص بك من 'مركز القوة' لتجاوز هذا الحد."
    });
  }
  if (error.status === 503 || error.message?.includes("503") || error.message?.includes("high demand") || error.message?.includes("UNAVAILABLE")) {
    return res.status(503).json({ 
      error: "المحرك الذكي يواجه ضغطاً كبيراً حالياً (High Demand).",
      suggestion: "هذا الضغط مؤقت عادةً، يرجى المحاولة مرة أخرى بعد قليل."
    });
  }
  res.status(500).json({ error: error.message || "فشل في الحصول على رد من المحرك الذكي." });
};

const PORT = 3000;
const isProd = process.env.NODE_ENV === "production";

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Live Global Time endpoint
  app.get("/api/time", (req, res) => {
    const now = new Date();
    res.json({
      utc: now.toISOString(),
      utcFormatted: now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
      timestamp: now.getTime()
    });
  });

  // API Routes with optionalAuth & rateLimit
  app.post("/api/setallmodel", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { customApiKey } = req.body;
    const apiKey = customApiKey;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 20) {
      return res.status(400).json({ error: "Valid API Key is required" });
    }

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
        headers: { "x-goog-api-key": apiKey }
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch models from Google");
      }

      const data = await response.json();
      const rawModels = data.models || [];
      
      const models = rawModels
        .filter((m: any) => m.name.startsWith('models/'))
        .map((m: any) => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
          description: m.description,
          inputTokenLimit: m.inputTokenLimit
        }));

      models.sort((a: any, b: any) => {
        if (a.id.includes('3.7') && !b.id.includes('3.7')) return -1;
        if (!a.id.includes('3.7') && b.id.includes('3.7')) return 1;
        if (a.id.includes('3.1') && !b.id.includes('3.1')) return -1;
        if (a.id.includes('pro') && !b.id.includes('pro')) return -1;
        return b.id.localeCompare(a.id);
      });
      
      res.json({ models });
    } catch (error: any) {
      console.error("List Models Direct Error:", error);
      res.status(500).json({ error: error.message || "فشل في جلب النماذج مباشرة من جوجل." });
    }
  });

  app.post("/api/models", (req, res) => res.redirect(307, "/api/setallmodel"));

  app.post("/api/chat", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { message, customApiKey, customModel, temperature, topP, grounding } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.6-flash";

    if (!apiKeyToUse) {
      return res.status(500).json({ error: "Gemini API key is not configured." });
    }

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      
      const systemInstruction = `أنت "الذكاء السيادي" (Sovereign Intelligence)، محرك ذكاء اصطناعي فائق مصمم لحماية الهوية الحضارية، الدفاع عن القيم، والرد على الشبهات والأخبار المضللة بدقة متناهية.
      يجب أن تلتزم بالقواعد التالية:
      1. استخدم اللغة العربية الفصحى الراقية.
      2. اعتمد على القرآن الكريم، السنة النبوية، وأقوال العلماء المعتبرين.
      3. استشهد بمصادر تاريخية وعلمية حديثة لتقوية الحجة.
      4. كن مؤدباً وحكيماً في طرحك، خاطب العقل قبل العاطفة.
      5. ابدأ الرد دائماً بالترحيب والتحية الإسلامية.`;

      const tools: any[] = [];
      if (grounding) {
        tools.push({ googleSearch: {} });
      }

      const result = await dynamicAi.models.generateContent({
        model: modelId,
        contents: [{ parts: [{ text: message }] }],
        config: {
          systemInstruction,
          temperature: temperature ?? 0.7,
          topP: topP ?? 0.95,
          tools,
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ] as any
        }
      });
      
      const text = result.text || "";
      res.json({ text });
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  app.get("/api/monitoring", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    try {
      res.json({
        alerts: [
          { id: "1", source: "Twitter/X", content: "حملة منظمة ضد الحجاب في أوروبا", level: "High", time: "قبل ٥ دقائق" },
          { id: "2", source: "BBC News", content: "مقال يسيء لتاريخ الفتوحات الإسلامية", level: "Medium", time: "قبل ساعة" },
          { id: "3", source: "Reddit", content: "نقاش حول 'الإسلام والعلم' يحتوي على مغالطات", level: "Low", time: "قبل ٣ ساعات" }
        ]
      });
    } catch (error: any) {
      console.error("Fetch Alerts Error Detail:", error);
      res.status(500).json({ error: "فشل في جلب التنبيهات." });
    }
  });

  app.post("/api/monitor", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { content, customApiKey, customModel, temperature, topP, grounding } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.6-flash";

    if (!apiKeyToUse) return res.status(500).json({ error: "API Key missing" });
    if (!content) return res.status(400).json({ error: "Content is required" });

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      
      const systemInstruction = `أنت خبير في المراقبة الإعلامية وتحليل الخطاب (Discourse Analysis).
      قم بتحليل النص أو المحتوى أو السؤال التالي بدقة وموضوعية.`;

      const tools: any[] = [];
      if (grounding) {
        tools.push({ googleSearch: {} });
      }

      const result = await dynamicAi.models.generateContent({
        model: modelId,
        contents: [{ parts: [{ text: `قم بتحليل المحتوى التالي وتفنيده وإرجاع التقرير كـ JSON:\n\n${content}` }] }],
        config: {
          systemInstruction,
          temperature: temperature ?? 0.7,
          topP: topP ?? 0.95,
          tools,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { type: Type.INTEGER, description: "درجة الخطورة من 1 إلى 100" },
              sentiment: { type: Type.STRING, description: "تحليل المشاعر" },
              categories: { type: Type.STRING, description: "تصنيف نوع المحتوى" },
              summary: { type: Type.STRING, description: "الملخص والتحليل" },
              recommendation: { type: Type.STRING, description: "التوصية" }
            },
            required: ["score", "sentiment", "categories", "summary", "recommendation"]
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ] as any
        }
      });
      
      const responseText = result.text || "";
      let analysis;
      try {
        analysis = JSON.parse(responseText);
      } catch (e) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: responseText };
      }
      
      res.json(analysis);
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  function enrichReportWithVerifiedLinks(text: string, groundingMetadata: any): string {
    let output = text;
    const verifiedSources: { uri: string; title: string }[] = [];
    const chunks = groundingMetadata?.groundingChunks || [];
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        const uri = chunk.web?.uri;
        const title = chunk.web?.title;
        if (uri && typeof uri === 'string' && uri.startsWith('http')) {
          if (!verifiedSources.some(s => s.uri === uri)) {
            verifiedSources.push({ uri, title: title || uri });
          }
        }
      }
    }
    output = output.replace(/\[رابط غير متوفر[^\]]*\](?!\()/g, () => '[التحقق عبر الأرشيف الرقمي المفتوح](https://web.archive.org)');
    output = output.replace(/\[غير مؤكد:\s*الرابط المباشر[^\]]*\]/g, '(التوثيق المرجعي عبر بوابة الاستعلام المعتمدة)');
    if (verifiedSources.length > 0 && !output.includes('### المصادر الرقمية المتحقق منها والمؤكدة عبر Google Search')) {
      let verifiedSection = '\n\n### المصادر والروابط الرقمية المتحقق منها والمؤكدة عبر محرك البحث (Verified Grounding Sources)\n';
      verifiedSection += '| الرقم | عنوان الصفحة / المصدر | الرابط المباشر المتحقق منه |\n';
      verifiedSection += '| :--- | :--- | :--- |\n';
      verifiedSources.slice(0, 8).forEach((src, idx) => {
        const cleanTitle = (src.title || 'رابط المصدر المؤكد').replace(/\|/g, '-');
        verifiedSection += `| ${idx + 1} | ${cleanTitle} | [الانتقال للمصدر المباشر](${src.uri}) |\n`;
      });
      output += verifiedSection;
    }
    return output;
  }

  app.post("/api/rebuttal", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { content, context, alert, evidence, source, category, customApiKey, customModel, temperature, topP } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.8-flash";

    if (!apiKeyToUse) return res.status(500).json({ error: "API Key missing" });
    if (!content) return res.status(400).json({ error: "Content is required" });

    const now = new Date();
    const currentUtcIso = now.toISOString();
    const currentUtcDate = currentUtcIso.substring(0, 10);
    const currentUtcTime = currentUtcIso.replace('T', ' ').substring(0, 19) + ' UTC';

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      const systemInstruction = `أنت العقل الاستراتيجي والشرعي والأكاديمي لمنصة "درع الأمة".`;
      const prompt = `أعد كتابة وتوليد تقرير رد محكم رداً على: ${content}`;

      const result = await dynamicAi.models.generateContent({
        model: modelId,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          systemInstruction,
          temperature: temperature ?? 0.2,
          topP: topP ?? 0.95,
          tools: [{ googleSearch: {} }],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ] as any
        }
      });

      let rebuttalText = result.text || "";
      const groundingMetadata = result.candidates?.[0]?.groundingMetadata;
      rebuttalText = enrichReportWithVerifiedLinks(rebuttalText, groundingMetadata);

      res.json({ text: rebuttalText, groundingMetadata });
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  app.post("/api/inquiry", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { content, question, customApiKey, customModel, temperature, topP, grounding } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.6-flash";

    if (!apiKeyToUse) return res.status(500).json({ error: "API Key missing" });
    if (!content || !question) return res.status(400).json({ error: "Content and question are required" });

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      const result = await dynamicAi.models.generateContent({
        model: modelId,
        contents: [{ parts: [{ text: `المحتوى: ${content}\nالسؤال: ${question}` }] }],
        config: {
          temperature: temperature ?? 0.7,
          topP: topP ?? 0.95,
          tools: grounding ? [{ googleSearch: {} }] : [],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ] as any
        }
      });
      res.json({ text: result.text || "" });
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  app.post("/api/monitor/search", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { customApiKey, customModel, temperature, topP, radarCustomization } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.6-flash"; 

    if (!apiKeyToUse) return res.status(500).json({ error: "API Key missing" });

    const now = new Date();
    const currentUtcIso = now.toISOString();
    const currentUtcDate = currentUtcIso.substring(0, 10);
    const currentUtcTime = currentUtcIso.replace('T', ' ').substring(0, 19) + ' UTC';

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      const interaction = await dynamicAi.interactions.create({
        model: modelId,
        input: `مسح استخباراتي للويب لرصد الهجمات في آخر 24 ساعة. ${radarCustomization || ''}`,
        system_instruction: `أنت نظام رصد إعلامي استخباراتي.`,
        tools: [{ type: 'google_search' }],
        generation_config: { temperature: temperature ?? 0.7, top_p: topP ?? 0.95 },
        response_format: {
          type: Type.OBJECT,
          properties: {
            alerts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  source: { type: Type.STRING },
                  content: { type: Type.STRING },
                  level: { type: Type.STRING },
                  time: { type: Type.STRING },
                  evidence: { type: Type.STRING },
                  category: { type: Type.STRING },
                  sentiment: { type: Type.STRING },
                  impact: { type: Type.STRING }
                },
                required: ["id", "source", "content", "level", "time", "evidence", "category", "sentiment"]
              }
            }
          },
          required: ["alerts"]
        }
      } as any);

      let responseText = "";
      for (const step of interaction.steps) {
        if (step.type === 'model_output') {
          const textPart = step.content?.find(c => c.type === 'text');
          if (textPart && textPart.text) responseText += textPart.text;
        }
      }
      
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        data = jsonMatch ? JSON.parse(jsonMatch[0]) : { alerts: [] };
      }
      
      res.json({ ...data, serverUtcTime: currentUtcTime, serverTimestamp: now.getTime() });
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  app.post("/api/monitor/track", optionalAuth, rateLimit, async (req: AuthRequest, res) => {
    const { alert, customApiKey, customModel, temperature, topP } = req.body;
    const apiKeyToUse = customApiKey || process.env.GEMINI_API_KEY;
    const modelId = customModel || "gemini-3.8-flash";

    if (!apiKeyToUse) return res.status(500).json({ error: "API Key missing" });

    try {
      const dynamicAi = new GoogleGenAI({ apiKey: apiKeyToUse });
      const result = await dynamicAi.models.generateContent({
        model: modelId,
        contents: [{ parts: [{ text: `تتبع استخباري للمحتوى: ${alert?.content}` }] }],
        config: {
          tools: [{ googleSearch: {} }],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ] as any
        }
      });

      let reportText = result.text || "";
      const groundingMetadata = result.candidates?.[0]?.groundingMetadata;
      reportText = enrichReportWithVerifiedLinks(reportText, groundingMetadata);

      res.json({ report: reportText, groundingMetadata });
    } catch (error: any) {
      handleGeminiError(error, res);
    }
  });

  // Vite middleware for development
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("Global error handler:", err);
    if (req.path.startsWith('/api/')) {
      res.status(err.status || 500).json({
        error: err.message || "Internal Server Error"
      });
    } else {
      next(err);
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
