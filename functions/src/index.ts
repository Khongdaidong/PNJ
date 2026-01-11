import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import type { Request, Response } from "express";
admin.initializeApp();

const LOCAL_ALLOWED_ORIGINS = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]);

const CORS_HEADERS = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
};

const getPrimaryHost = (req: Request) => {
    const forwardedHost = req.get("x-forwarded-host");
    if (forwardedHost) {
        return forwardedHost.split(",")[0].trim();
    }
    return req.get("host") ?? "";
};

const getAllowedOrigins = (req: Request) => {
    const origins = new Set<string>(LOCAL_ALLOWED_ORIGINS);
    const configured = (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    configured.forEach((origin) => origins.add(origin));

    const host = getPrimaryHost(req);
    if (host) {
        origins.add(`https://${host}`);
        origins.add(`http://${host}`);
    }
    return origins;
};

const applyCors = (req: Request, res: Response) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        res.set(key, value);
    }

    const origin = req.get("origin");
    if (!origin) {
        return { ok: true };
    }

    const allowedOrigins = getAllowedOrigins(req);
    if (!allowedOrigins.has(origin)) {
        return { ok: false, origin };
    }

    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    return { ok: true };
};

type NewsItem = {
    id: string;
    title: string;
    summary: string;
    date: string;
    source: string;
    tag: string;
};

const NEWS_DATA: NewsItem[] = [
    {
        id: "news_1",
        title: "Cổ phiếu PNJ khởi sắc đầu năm 2026",
        summary: "Cổ phiếu PNJ giao dịch quanh mức 97.000 VND đầu tháng 1/2026, tăng ~7% trong tháng qua. Giới phân tích duy trì khuyến nghị khả quan với giá mục tiêu trung bình ~105.000 VND, kỳ vọng vào sự phục hồi của sức mua trang sức dịp Tết.",
        date: "02/01/2026",
        source: "TradingView / Tổng hợp",
        tag: "Thị trường"
    },
    {
        id: "news_2",
        title: "Kết quả kinh doanh Q3/2025 vượt dự báo",
        summary: "PNJ công bố KQKD Quý 3/2025 tích cực với EPS đạt 1.460 VND (vượt dự báo >200%). Doanh thu quý đạt 8.14 nghìn tỷ đồng. Kết quả này giúp củng cố niềm tin nhà đầu tư sau nửa đầu năm thận trọng.",
        date: "11/2025",
        source: "Báo cáo tài chính",
        tag: "Tài chính"
    },
    {
        id: "news_3",
        title: "Biên lợi nhuận gộp cải thiện mạnh trong năm 2025",
        summary: "Lũy kế 9 tháng 2025, biên lợi nhuận gộp của PNJ phục hồi lên mức >21% (so với 17-18% cùng kỳ) nhờ tái cơ cấu danh mục sản phẩm và gia tăng tỷ trọng bán lẻ trang sức thay vì vàng miếng.",
        date: "09/2025",
        source: "PNJ IR",
        tag: "Hoạt động"
    },
    {
        id: "news_4",
        title: "Hoàn tất khắc phục các vấn đề thanh tra",
        summary: "Liên quan đến đợt thanh tra thị trường vàng giữa năm 2025, PNJ đã nộp phạt hành chính 1.34 tỷ đồng và hoàn tất khắc phục các thiếu sót về nhãn mác/báo cáo. Công ty khẳng định tuân thủ chặt chẽ pháp luật.",
        date: "06/2025",
        source: "TheInvestor",
        tag: "Công bố TT"
    },
    {
        id: "news_5",
        title: "Thương hiệu trang sức giá trị nhất Việt Nam (523 triệu USD)",
        summary: "Brand Finance định giá thương hiệu PNJ đạt 523 triệu USD trong báo cáo 2025, tăng 9% so với năm trước, tiếp tục giữ vững vị thế thương hiệu bán lẻ trang sức số 1 Việt Nam.",
        date: "2025",
        source: "Brand Finance",
        tag: "Thương hiệu"
    }
];

export const getSentiments = functions.https.onRequest(async (req, res) => {
    const corsResult = applyCors(req, res);
    if (!corsResult.ok) {
        res.status(403).send("Origin not allowed");
        return;
    }

    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }

    if (req.method !== "GET") {
        res.status(405).send("Method not allowed");
        return;
    }

    try {
        const db = admin.firestore();
        const snapshot = await db.collection("sentiments").select("sentiment").get();
        const sentiments: Record<string, unknown> = {};
        snapshot.forEach((doc) => {
            const data = doc.data();
            if (Object.prototype.hasOwnProperty.call(data, "sentiment")) {
                sentiments[doc.id] = data.sentiment;
            }
        });
        res.json({
            news: NEWS_DATA,
            sentiments
        });
    } catch (error) {
        console.error("Error fetching cached sentiments:", error);
        res.status(500).send("Error fetching sentiments");
    }
});
