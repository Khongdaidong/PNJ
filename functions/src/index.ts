import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
admin.initializeApp();

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
    // Add CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Methods", "GET");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.status(204).send("");
        return;
    }

    try {
        const db = admin.firestore();
        const snapshot = await db.collection("sentiments").get();
        const sentiments: Record<string, any> = {};
        snapshot.forEach((doc) => {
            sentiments[doc.id] = doc.data().sentiment;
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
