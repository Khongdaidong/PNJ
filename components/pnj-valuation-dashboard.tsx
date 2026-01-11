/* eslint-disable react-hooks/static-components */
"use client";

import React, { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    LineChart,
    Line,
    Legend,
} from "recharts";
import { Info, RefreshCw } from "lucide-react";

// -----------------------------
// Formatters
// -----------------------------
const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const pct0 = new Intl.NumberFormat("vi-VN", {
    style: "percent",
    maximumFractionDigits: 0,
});
const pct1 = new Intl.NumberFormat("vi-VN", {
    style: "percent",
    maximumFractionDigits: 1,
});

// -----------------------------
// Small helpers
// -----------------------------
function safeNum(x: unknown, fallback = 0) {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : fallback;
}

function roundTo(x: number, digits = 0) {
    const p = Math.pow(10, digits);
    return Math.round(x * p) / p;
}

function clamp(x: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, x));
}

// -----------------------------
// Core valuation math
// Units:
// - bnVND: tỷ VND
// - VND/share: đồng/cp
// -----------------------------
function planEPSVND(planNPAT_bn: number, shares: number) {
    return shares > 0 ? (planNPAT_bn * 1e9) / shares : 0;
}

function priceFromPE(epsVND: number, pe: number) {
    return epsVND * pe;
}

function netCashBn(cash_bn: number, htm_bn: number, borrow_bn: number) {
    return cash_bn + htm_bn - borrow_bn;
}

function bvpsVND(totalEquity_bn: number, shares: number) {
    return shares > 0 ? (totalEquity_bn * 1e9) / shares : 0;
}

type DCFInputs = {
    rev2025_bn: number; // base revenue in 2025
    cagr: number; // fallback CAGR 2026-2030 (if no revSeries)
    revSeries_bn?: number[]; // optional explicit revenue path for 2026-2030
    ebitMargin: number;
    tax: number;
    roc: number;
    wacc: number;
    gT: number;
    netCash_bn: number;
    shares: number;
};

function dcfFCFF(i: DCFInputs) {
    const years = [2026, 2027, 2028, 2029, 2030];
    const rocSafe = Math.max(i.roc, 1e-6);
    const revSeries =
        i.revSeries_bn && i.revSeries_bn.length === 5
            ? i.revSeries_bn
            : years.map((_, idx) => {
                const t = idx + 1;
                return i.rev2025_bn * Math.pow(1 + i.cagr, t);
            });

    const rows = years.map((y, idx) => {
        const t = idx + 1; // discount periods from end-2026
        const rev = revSeries[idx] ?? 0;

        const prevRev = idx === 0 ? i.rev2025_bn : revSeries[idx - 1] ?? i.rev2025_bn;
        const g = prevRev > 0 ? rev / prevRev - 1 : i.cagr;

        const ebit = rev * i.ebitMargin;
        const nopat = ebit * (1 - i.tax);

        // reinvest ~ g/ROC (clamp to [0, 95%] to avoid pathological outputs)
        const reinvRate = clamp(g / rocSafe, 0, 0.95);
        const fcff = nopat * (1 - reinvRate);

        const disc = 1 / Math.pow(1 + i.wacc, t);
        const pv = fcff * disc;

        return { y, t, rev, g, ebit, nopat, reinvRate, fcff, disc, pv };
    });

    const rev2030 = rows[rows.length - 1].rev;
    const rev2031 = rev2030 * (1 + i.gT);
    const ebit2031 = rev2031 * i.ebitMargin;
    const nopat2031 = ebit2031 * (1 - i.tax);
    const reinvTerm = clamp(i.gT / rocSafe, 0, 0.95);
    const fcff2031 = nopat2031 * (1 - reinvTerm);

    // TV guard
    const spread = Math.max(0.001, i.wacc - i.gT);
    const tv = fcff2031 / spread;
    const pvTV = tv / Math.pow(1 + i.wacc, 5);

    const pvFCFF = rows.reduce((s, r) => s + r.pv, 0);
    const ev_bn = pvFCFF + pvTV;
    const eq_bn = ev_bn + i.netCash_bn;
    const vps = i.shares > 0 ? (eq_bn * 1e9) / i.shares : 0;

    return {
        rows,
        pvFCFF,
        tv,
        pvTV,
        ev_bn,
        eq_bn,
        vps,
    };
}

// -----------------------------
// Store KPI driver (anchored to Plan)
// -----------------------------
type StoreKPIInputs = {
    startStores: number; // baseline
    netNewStores: number; // mở ròng 12M
    ramp: number; // đóng góp DT của store mới so với store trưởng thành (0..1)
    sssgDelta: number; // delta vs plan (vd -0.02)
    opLeverage: number; // độ nhạy LNST theo DT
};

function effectiveAvgStores(startStores: number, netNewStores: number, ramp: number) {
    const s0 = Math.max(0, startStores);
    const nn = netNewStores;
    const r = clamp(ramp, 0, 1);
    // mở đều trong năm: average new stores ~ netNew/2; DT của store mới nhân ramp
    return s0 + (nn / 2) * r;
}

function storeDrivenScenario(
    planRevenue_bn: number,
    planNPAT_bn: number,
    shares: number,
    base: StoreKPIInputs,
    scenario: StoreKPIInputs
) {
    const baseEff = Math.max(1e-6, effectiveAvgStores(base.startStores, base.netNewStores, base.ramp));
    const scenEff = Math.max(0, effectiveAvgStores(scenario.startStores, scenario.netNewStores, scenario.ramp));

    // Revenue anchored to plan: scale by effective average stores and SSSG delta vs plan
    const rev = planRevenue_bn * (scenEff / baseEff) * (1 + scenario.sssgDelta);

    // NPAT anchored to plan with optional operating leverage
    const revRatio = planRevenue_bn > 0 ? Math.max(0, rev / planRevenue_bn) : 0;
    const opLev = clamp(scenario.opLeverage, 0.5, 2.0);
    const npat = planNPAT_bn * Math.pow(revRatio, opLev);

    const eps = shares > 0 ? (npat * 1e9) / shares : 0;
    const epsVsPlan = planNPAT_bn > 0 ? npat / planNPAT_bn - 1 : 0;

    const endStores = Math.max(0, scenario.startStores + scenario.netNewStores);

    return {
        endStores,
        avgStoresEff: scenEff,
        revenue_bn: rev,
        npat_bn: npat,
        epsVND: eps,
        epsVsPlan,
        revRatio,
    };
}

// -----------------------------
// Store-driven revenue path for DCF
// Idea: only a % of revenue is driven by stores (retailShare);
// the rest grows by a separate "otherCagr".
// -----------------------------
type StoreDCFRow = {
    year: number;
    storesStart: number;
    storesEnd: number;
    avgStoresEff: number;
    sssgAbs: number;
    retailRev_bn: number;
    otherRev_bn: number;
    revenue_bn: number;
    yoy: number;
};

function buildStoreDCFSeries(params: {
    rev2025_bn: number;
    retailShare: number; // fraction of revenue linked to stores
    otherCagr: number; // growth for non-store-linked revenue
    storeStart: number; // starting stores at end-2025
    netNewPerYear: number; // assumed net new stores per year (applied 2026-2030)
    ramp: number; // first-year productivity for new stores (0..1)
    sssgAbs: number; // absolute SSSG per year (not delta)
}) {
    const years = [2026, 2027, 2028, 2029, 2030];

    const retailShare = clamp(params.retailShare, 0, 1);
    const otherShare = 1 - retailShare;

    const storeStart = Math.max(0, Math.floor(params.storeStart));
    const nn = Math.floor(params.netNewPerYear);
    const ramp = clamp(params.ramp, 0, 1);

    // allow slightly negative SSSG in stress; cap to avoid crazy outputs
    const sssg = clamp(params.sssgAbs, -0.05, 0.20);
    const otherCagr = clamp(params.otherCagr, -0.05, 0.20);

    // Back out "mature" retail revenue per effective average store from 2025 base.
    // Effective avg stores in 2025 approximated using the same nn + ramp.
    const baseEff2025 = Math.max(1e-6, effectiveAvgStores(storeStart, nn, ramp));
    const retailRev2025 = params.rev2025_bn * retailShare;
    const otherRev2025 = params.rev2025_bn * otherShare;
    const matureRetailRevPerEffStore = retailRev2025 / baseEff2025;

    const rows: StoreDCFRow[] = [];
    let prevTotal = params.rev2025_bn;

    years.forEach((year, idx) => {
        const t = idx + 1; // 2026..2030 = 1..5

        const storesStart = storeStart + nn * (t - 1);
        const storesEnd = storesStart + nn;
        const avgStoresEff = storesStart + (nn / 2) * ramp;

        const retailRev = matureRetailRevPerEffStore * avgStoresEff * Math.pow(1 + sssg, t);
        const otherRev = otherRev2025 * Math.pow(1 + otherCagr, t);
        const total = retailRev + otherRev;
        const yoy = prevTotal > 0 ? total / prevTotal - 1 : 0;

        rows.push({
            year,
            storesStart,
            storesEnd,
            avgStoresEff,
            sssgAbs: sssg,
            retailRev_bn: retailRev,
            otherRev_bn: otherRev,
            revenue_bn: total,
            yoy,
        });

        prevTotal = total;
    });

    const impliedCAGR = params.rev2025_bn > 0 ? Math.pow(rows[rows.length - 1].revenue_bn / params.rev2025_bn, 1 / 5) - 1 : 0;

    return { rows, impliedCAGR };
}

// -----------------------------
// UI components
// -----------------------------
function Metric({
    label,
    value,
    sub,
    valueClassName,
}: {
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
    valueClassName?: string;
}) {
    return (
        <div className="rounded-2xl border p-3">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className={`mt-1 text-xl font-semibold leading-tight ${valueClassName || ""}`}>{value}</div>
            {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
        </div>
    );
}

function NumberInput({
    label,
    value,
    onChange,
    suffix,
    step,
    min,
}: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    suffix?: string;
    step?: number;
    min?: number;
}) {
    return (
        <div className="space-y-2">
            <Label className="text-sm">{label}</Label>
            <div className="flex items-center gap-2">
                <Input
                    type="number"
                    step={step ?? "any"}
                    value={Number.isFinite(value) ? value : 0}
                    onChange={(e) => {
                        const v = safeNum(e.target.value);
                        onChange(min != null ? Math.max(min, v) : v);
                    }}
                />
                {suffix ? <div className="min-w-12 text-sm text-muted-foreground">{suffix}</div> : null}
            </div>
        </div>
    );
}

function PercentSlider({
    label,
    value,
    onChange,
    min,
    max,
    step = 0.5, // in percentage points (e.g. 0.5 = 0.5%)
    hint,
}: {
    label: string;
    value: number; // fraction (e.g., 0.08 = 8%)
    onChange: (v: number) => void;
    min: number;
    max: number;
    step?: number;
    hint?: string;
}) {
    const display = pct1.format(value);
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <Label className="text-sm">{label}</Label>
                <Badge variant="secondary">{display}</Badge>
            </div>
            <Slider
                value={[value * 100]}
                min={min * 100}
                max={max * 100}
                step={step}
                onValueChange={(v) => onChange(v[0] / 100)}
            />
            {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
    );
}

type ScenarioName = "Bear" | "Base" | "Bull";

const QUARTERS_12M = ["Q1", "Q2", "Q3", "Q4"];

// -----------------------------
// Main
// -----------------------------
export default function PNJValuationDashboard() {
    // -------- Inputs (default from your Excel model) --------
    const [price, setPrice] = useState(95900);
    const [shares, setShares] = useState(341_149_107);
    const [planNPAT, setPlanNPAT] = useState(1959.65); // bn
    const [npat9m, setNpat9m] = useState(1610.0); // bn
    const [planRevenue, setPlanRevenue] = useState(31606.954); // bn

    // Balance sheet for net cash (cross-check)
    const [cash, setCash] = useState(4122.714);
    const [htm, setHtm] = useState(1020.17);
    const [borrow, setBorrow] = useState(3341.542);
    const [totalEquity, setTotalEquity] = useState(11256.955);

    // DCF drivers
    const [tax, setTax] = useState(0.2);
    const [ebitMargin, setEbitMargin] = useState(0.07);
    const [cagr, setCagr] = useState(0.08);
    const [gT, setGT] = useState(0.03);
    const [roc, setRoc] = useState(0.18);
    const [wacc, setWacc] = useState(0.09);

    // DCF store driver toggles/inputs
    const [useStoreDCF, setUseStoreDCF] = useState(true);
    const [retailShareDCF, setRetailShareDCF] = useState(0.85);
    const [baseSSSG_DCF, setBaseSSSG_DCF] = useState(0.04);
    const [otherCagrDCF, setOtherCagrDCF] = useState(0.03);

    // CAPM (optional informational)
    const [rf, setRf] = useState(0.0418);
    const [beta, setBeta] = useState(0.52);
    const [erp, setErp] = useState(0.083455);

    // P/B
    const [pbMultiple, setPbMultiple] = useState(2.8);

    // Scenario definitions (P/E + EPS override)
    const [scBear, setScBear] = useState({ epsVsPlan: -0.08, pe: 15 });
    const [scBase, setScBase] = useState({ epsVsPlan: 0.0, pe: 17 });
    const [scBull, setScBull] = useState({ epsVsPlan: 0.1, pe: 19 });
    const [activeScenario, setActiveScenario] = useState<ScenarioName>("Base");

    // -------- Store KPI driver --------
    const [useStoreKPI, setUseStoreKPI] = useState(true);
    const [startStores, setStartStores] = useState(429); // baseline

    // Base plan store expansion (12M)
    const [baseNetNewStores, setBaseNetNewStores] = useState(20);

    // Scenario deltas
    const [bearNetNewStores, setBearNetNewStores] = useState(10);
    const [bullNetNewStores, setBullNetNewStores] = useState(30);

    // SSSG delta vs plan
    const [sssgBear, setSssgBear] = useState(-0.02);
    const [sssgBase, setSssgBase] = useState(0.0);
    const [sssgBull, setSssgBull] = useState(0.03);

    // New store ramp
    const [newStoreRamp, setNewStoreRamp] = useState(0.7);

    // Operating leverage
    const [opLeverage, setOpLeverage] = useState(1.0);

    // Store tracker (quarterly actual)
    const [actualStoresByQuarter, setActualStoresByQuarter] = useState<number[]>(Array.from({ length: 4 }, () => NaN));

    // Method toggles & weights
    const [usePE, setUsePE] = useState(true);
    const [useDCF, setUseDCF] = useState(true);
    const [usePB, setUsePB] = useState(true);
    const [wPE, setWPE] = useState(60);
    const [wDCF, setWDCF] = useState(30);
    const [wPB, setWPB] = useState(10);

    const netCash = useMemo(() => netCashBn(cash, htm, borrow), [cash, htm, borrow]);
    const planEPS = useMemo(() => planEPSVND(planNPAT, shares), [planNPAT, shares]);
    const forwardPE = useMemo(() => (planEPS > 0 ? price / planEPS : 0), [price, planEPS]);
    const mktCapBn = useMemo(() => (price * shares) / 1e9, [price, shares]);
    const bvps = useMemo(() => bvpsVND(totalEquity, shares), [totalEquity, shares]);
    const pbValue = useMemo(() => bvps * pbMultiple, [bvps, pbMultiple]);
    const pbImplied = useMemo(() => (bvps > 0 ? price / bvps : 0), [price, bvps]);
    const costOfEquity = useMemo(() => rf + beta * erp, [rf, beta, erp]);

    // Base store plan definition (anchored)
    const baseStorePlan: StoreKPIInputs = useMemo(
        () => ({
            startStores,
            netNewStores: baseNetNewStores,
            ramp: newStoreRamp,
            sssgDelta: sssgBase,
            opLeverage,
        }),
        [startStores, baseNetNewStores, newStoreRamp, sssgBase, opLeverage]
    );

    const storeScenarioParams = useMemo(() => {
        const bear: StoreKPIInputs = {
            startStores,
            netNewStores: bearNetNewStores,
            ramp: newStoreRamp,
            sssgDelta: sssgBear,
            opLeverage,
        };
        const base: StoreKPIInputs = {
            startStores,
            netNewStores: baseNetNewStores,
            ramp: newStoreRamp,
            sssgDelta: sssgBase,
            opLeverage,
        };
        const bull: StoreKPIInputs = {
            startStores,
            netNewStores: bullNetNewStores,
            ramp: newStoreRamp,
            sssgDelta: sssgBull,
            opLeverage,
        };
        return { bear, base, bull };
    }, [
        startStores,
        bearNetNewStores,
        baseNetNewStores,
        bullNetNewStores,
        newStoreRamp,
        sssgBear,
        sssgBase,
        sssgBull,
        opLeverage,
    ]);

    const scenarioTable = useMemo(() => {
        const makeRow = (name: ScenarioName, epsVsPlan: number, pe: number, storeCfg?: StoreKPIInputs) => {
            if (useStoreKPI && storeCfg) {
                const out = storeDrivenScenario(planRevenue, planNPAT, shares, baseStorePlan, storeCfg);
                const tp = priceFromPE(out.epsVND, pe);
                const upside = price > 0 ? tp / price - 1 : 0;
                const q4Req = out.npat_bn - npat9m;
                return {
                    name,
                    driver: "STORE" as const,
                    pe,
                    epsVsPlan: out.epsVsPlan,
                    revenue_bn: out.revenue_bn,
                    npat: out.npat_bn,
                    eps: out.epsVND,
                    tp,
                    upside,
                    q4Req,
                    storesStart: storeCfg.startStores,
                    storesEnd: out.endStores,
                    netNewStores: storeCfg.netNewStores,
                    avgStoresEff: out.avgStoresEff,
                    sssgDelta: storeCfg.sssgDelta,
                };
            }

            const npat = planNPAT * (1 + epsVsPlan);
            const eps = shares > 0 ? (npat * 1e9) / shares : 0;
            const tp = priceFromPE(eps, pe);
            const upside = price > 0 ? tp / price - 1 : 0;
            const q4Req = npat - npat9m;
            return {
                name,
                driver: "EPS" as const,
                epsVsPlan,
                pe,
                npat,
                eps,
                tp,
                upside,
                q4Req,
                revenue_bn: NaN,
                storesStart: NaN,
                storesEnd: NaN,
                netNewStores: NaN,
                avgStoresEff: NaN,
                sssgDelta: NaN,
            };
        };

        return [
            makeRow("Bear", scBear.epsVsPlan, scBear.pe, storeScenarioParams.bear),
            makeRow("Base", scBase.epsVsPlan, scBase.pe, storeScenarioParams.base),
            makeRow("Bull", scBull.epsVsPlan, scBull.pe, storeScenarioParams.bull),
        ];
    }, [useStoreKPI, planRevenue, planNPAT, shares, price, npat9m, baseStorePlan, storeScenarioParams, scBear, scBase, scBull]);

    const activeRow = useMemo(
        () => scenarioTable.find((r) => r.name === activeScenario) ?? scenarioTable[1],
        [scenarioTable, activeScenario]
    );

    // Monthly store plan (Base) for tracking
    const basePlanStoresByQuarter = useMemo(() => {
        const s0 = Math.max(0, startStores);
        const nn = baseNetNewStores;
        return QUARTERS_12M.map((q, idx) => {
            const t = (idx + 1) / 4;
            const endStores = Math.round(s0 + nn * t);
            return { quarter: q, plannedEndStores: endStores };
        });
    }, [startStores, baseNetNewStores]);

    const latestActualStores = useMemo(() => {
        for (let i = actualStoresByQuarter.length - 1; i >= 0; i--) {
            const v = actualStoresByQuarter[i];
            if (Number.isFinite(v)) return v;
        }
        return startStores;
    }, [actualStoresByQuarter, startStores]);

    const storeTrackerSeries = useMemo(() => {
        return QUARTERS_12M.map((q, idx) => ({
            quarter: q,
            planned: basePlanStoresByQuarter[idx]?.plannedEndStores ?? NaN,
            actual: actualStoresByQuarter[idx],
        }));
    }, [actualStoresByQuarter, basePlanStoresByQuarter]);

    // DCF: build store-driven revenue series (scenario-aware)
    const dcfStoreCfg = useMemo(() => {
        const sc = activeScenario === "Bear" ? storeScenarioParams.bear : activeScenario === "Bull" ? storeScenarioParams.bull : storeScenarioParams.base;
        return {
            storeStart: latestActualStores,
            netNewPerYear: sc.netNewStores,
            ramp: sc.ramp,
            sssgAbs: baseSSSG_DCF + sc.sssgDelta,
        };
    }, [activeScenario, storeScenarioParams, latestActualStores, baseSSSG_DCF]);

    const storeDCF = useMemo(() => {
        if (!useStoreDCF) return null;
        return buildStoreDCFSeries({
            rev2025_bn: planRevenue,
            retailShare: retailShareDCF,
            otherCagr: otherCagrDCF,
            storeStart: dcfStoreCfg.storeStart,
            netNewPerYear: dcfStoreCfg.netNewPerYear,
            ramp: dcfStoreCfg.ramp,
            sssgAbs: dcfStoreCfg.sssgAbs,
        });
    }, [useStoreDCF, planRevenue, retailShareDCF, otherCagrDCF, dcfStoreCfg]);

    const dcf = useMemo(() => {
        const revSeries_bn = storeDCF ? storeDCF.rows.map((r) => r.revenue_bn) : undefined;

        const inp: DCFInputs = {
            rev2025_bn: planRevenue,
            cagr,
            revSeries_bn,
            ebitMargin,
            tax,
            roc,
            wacc,
            gT,
            netCash_bn: netCash,
            shares,
        };

        // guard for invalid wacc-g
        const waccSafe = Math.max(inp.wacc, inp.gT + 0.005);
        const out = dcfFCFF({ ...inp, wacc: waccSafe });
        return { inp: { ...inp, wacc: waccSafe }, out };
    }, [planRevenue, cagr, storeDCF, ebitMargin, tax, roc, wacc, gT, netCash, shares]);

    const normalizedWeights = useMemo(() => {
        const a = usePE ? wPE : 0;
        const b = useDCF ? wDCF : 0;
        const c = usePB ? wPB : 0;
        const s = a + b + c;
        if (s <= 0) return { wPE: 0, wDCF: 0, wPB: 0, sum: 0 };
        return { wPE: a / s, wDCF: b / s, wPB: c / s, sum: s };
    }, [usePE, useDCF, usePB, wPE, wDCF, wPB]);

    const blendedValue = useMemo(() => {
        const peV = activeRow.tp;
        const dcfV = dcf.out.vps;
        const pbV = pbValue;
        const v = (usePE ? normalizedWeights.wPE * peV : 0) + (useDCF ? normalizedWeights.wDCF * dcfV : 0) + (usePB ? normalizedWeights.wPB * pbV : 0);

        const up = price > 0 ? v / price - 1 : 0;

        return { peV, dcfV, pbV, v, up };
    }, [activeRow.tp, dcf.out.vps, pbValue, normalizedWeights, usePE, useDCF, usePB, price]);

    const scenarioChartData = useMemo(
        () =>
            scenarioTable.map((r) => ({
                scenario: r.name,
                target: roundTo(r.tp, 0),
                upside: roundTo(r.upside * 100, 1),
            })),
        [scenarioTable]
    );

    const dcfSeries = useMemo(
        () =>
            dcf.out.rows.map((r) => ({
                year: r.y,
                revenue: roundTo(r.rev, 1),
                fcff: roundTo(r.fcff, 1),
                pv: roundTo(r.pv, 1),
            })),
        [dcf.out.rows]
    );

    const resetDefaults = () => {
        setPrice(95900);
        setShares(341_149_107);
        setPlanNPAT(1959.65);
        setNpat9m(1610.0);
        setPlanRevenue(31606.954);

        setCash(4122.714);
        setHtm(1020.17);
        setBorrow(3341.542);
        setTotalEquity(11256.955);

        setTax(0.2);
        setEbitMargin(0.07);
        setCagr(0.08);
        setGT(0.03);
        setRoc(0.18);
        setWacc(0.09);

        setUseStoreDCF(true);
        setRetailShareDCF(0.85);
        setBaseSSSG_DCF(0.04);
        setOtherCagrDCF(0.03);

        setRf(0.0418);
        setBeta(0.52);
        setErp(0.083455);

        setPbMultiple(2.8);

        setScBear({ epsVsPlan: -0.08, pe: 15 });
        setScBase({ epsVsPlan: 0.0, pe: 17 });
        setScBull({ epsVsPlan: 0.1, pe: 19 });
        setActiveScenario("Base");

        setUsePE(true);
        setUseDCF(true);
        setUsePB(true);

        setWPE(60);
        setWDCF(30);
        setWPB(10);

        // Store KPI defaults
        setUseStoreKPI(true);
        setStartStores(429);
        setBaseNetNewStores(20);
        setBearNetNewStores(10);
        setBullNetNewStores(30);
        setSssgBear(-0.02);
        setSssgBase(0.0);
        setSssgBull(0.03);
        setNewStoreRamp(0.7);
        setOpLeverage(1.0);
        setActualStoresByQuarter(Array.from({ length: 4 }, () => NaN));
    };

    const ScenarioEditor = () => {
        const isBear = activeScenario === "Bear";
        const isBase = activeScenario === "Base";
        const s = isBear ? scBear : isBase ? scBase : scBull;
        const setS = isBear ? setScBear : isBase ? setScBase : setScBull;

        const netNew = isBear ? bearNetNewStores : isBase ? baseNetNewStores : bullNetNewStores;
        const setNetNew = isBear ? setBearNetNewStores : isBase ? setBaseNetNewStores : setBullNetNewStores;
        const sssg = isBear ? sssgBear : isBase ? sssgBase : sssgBull;
        const setSssg = isBear ? setSssgBear : isBase ? setSssgBase : setSssgBull;

        return (
            <Card className="rounded-2xl shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Chỉnh kịch bản đang chọn</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant={activeScenario === "Bear" ? "default" : "outline"} onClick={() => setActiveScenario("Bear")}>
                            Bear
                        </Button>
                        <Button size="sm" variant={activeScenario === "Base" ? "default" : "outline"} onClick={() => setActiveScenario("Base")}>
                            Base
                        </Button>
                        <Button size="sm" variant={activeScenario === "Bull" ? "default" : "outline"} onClick={() => setActiveScenario("Bull")}>
                            Bull
                        </Button>
                    </div>

                    <div className="rounded-2xl border p-3 bg-muted/30">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">Dùng KPI Cửa hàng để dẫn EPS</div>
                            <Switch checked={useStoreKPI} onCheckedChange={setUseStoreKPI} />
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                            Khi bật: EPS/LNST suy ra từ <b>số cửa hàng</b> + <b>SSSG so với kế hoạch</b>. Khi tắt: dùng slider “EPS vs plan”.
                        </div>
                    </div>

                    {useStoreKPI ? (
                        <>
                            <NumberInput
                                label="Net mở mới (12M) – kịch bản đang chọn"
                                value={netNew}
                                onChange={(v) => setNetNew(Math.floor(v))}
                                step={1}
                            />

                            <PercentSlider
                                label="SSSG so với kế hoạch (delta)"
                                value={sssg}
                                min={-0.1}
                                max={0.1}
                                step={0.2}
                                onChange={setSssg}
                                hint="Ví dụ: -2% nghĩa là SSSG thấp hơn kế hoạch 2%."
                            />

                            <PercentSlider
                                label="Ramp doanh thu cửa hàng mới"
                                value={newStoreRamp}
                                min={0.3}
                                max={1.0}
                                step={1}
                                onChange={setNewStoreRamp}
                                hint="Ví dụ 70%: cửa hàng mới tạo DT ~70% cửa hàng trưởng thành trong năm đầu."
                            />

                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label className="text-sm">Độ nhạy LNST theo DT (operating leverage)</Label>
                                    <Badge variant="secondary">{nf2.format(opLeverage)}x</Badge>
                                </div>
                                <Slider value={[opLeverage]} min={0.8} max={1.3} step={0.01} onValueChange={(v) => setOpLeverage(v[0])} />
                                <div className="text-xs text-muted-foreground">1.00x = tuyến tính; &gt;1.00x = có đòn bẩy chi phí (LNST nhạy hơn DT).</div>
                            </div>
                        </>
                    ) : (
                        <PercentSlider
                            label="EPS so với kế hoạch (FY2025)"
                            value={s.epsVsPlan}
                            min={-0.25}
                            max={0.25}
                            step={0.5}
                            onChange={(v) => setS({ ...s, epsVsPlan: v })}
                            hint="Ví dụ: -8% nghĩa là LNST 2025 thấp hơn kế hoạch 8%."
                        />
                    )}

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label className="text-sm">P/E mục tiêu</Label>
                            <Badge variant="secondary">{nf1.format(s.pe)}x</Badge>
                        </div>
                        <Slider value={[s.pe]} min={10} max={25} step={0.1} onValueChange={(v) => setS({ ...s, pe: v[0] })} />
                        <div className="text-xs text-muted-foreground">Gợi ý: band tham chiếu thường 15x–19x (tuỳ thị trường & chất lượng tăng trưởng).</div>
                    </div>

                    <div className="rounded-2xl border p-3 bg-muted/30">
                        <div className="flex items-start gap-2">
                            <Info className="h-4 w-4 mt-0.5" />
                            <div className="text-xs text-muted-foreground leading-relaxed">
                                Khi bật KPI cửa hàng, kịch bản hợp lý hơn vì <b>KPI hoạt động</b> (cửa hàng + SSSG) dẫn tới <b>LNST/EPS</b>, rồi <b>P/E</b> phản ánh tin tuc.
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        );
    };

    const WeightsPanel = () => (
        <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Blended valuation (trộn phương pháp)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-2xl border p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">P/E</div>
                            <Switch checked={usePE} onCheckedChange={setUsePE} />
                        </div>
                        <div className="mt-3">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground">Trọng số</div>
                                <Badge variant="secondary">{nf0.format(wPE)}%</Badge>
                            </div>
                            <Slider value={[wPE]} min={0} max={100} step={1} onValueChange={(v) => setWPE(v[0])} disabled={!usePE} />
                        </div>
                    </div>

                    <div className="rounded-2xl border p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">DCF</div>
                            <Switch checked={useDCF} onCheckedChange={setUseDCF} />
                        </div>
                        <div className="mt-3">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground">Trọng số</div>
                                <Badge variant="secondary">{nf0.format(wDCF)}%</Badge>
                            </div>
                            <Slider value={[wDCF]} min={0} max={100} step={1} onValueChange={(v) => setWDCF(v[0])} disabled={!useDCF} />
                        </div>
                    </div>

                    <div className="rounded-2xl border p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">P/B</div>
                            <Switch checked={usePB} onCheckedChange={setUsePB} />
                        </div>
                        <div className="mt-3">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground">Trọng số</div>
                                <Badge variant="secondary">{nf0.format(wPB)}%</Badge>
                            </div>
                            <Slider value={[wPB]} min={0} max={100} step={1} onValueChange={(v) => setWPB(v[0])} disabled={!usePB} />
                        </div>
                    </div>
                </div>

                <div className="rounded-2xl border p-3 bg-muted/30">
                    <div className="text-xs text-muted-foreground">
                        Trọng số được <b>tự chuẩn hoá</b> theo các phương pháp đang bật. Hiện tại: P/E {pct0.format(normalizedWeights.wPE)} • DCF {pct0.format(normalizedWeights.wDCF)} • P/B {pct0.format(normalizedWeights.wPB)}
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Metric
                        label="Giá trị P/E (kịch bản đang chọn)"
                        value={`${nf0.format(blendedValue.peV)} đ/cp`}
                        sub={`EPS vs plan: ${pct1.format(activeRow.epsVsPlan)} • P/E: ${nf1.format(activeRow.pe)}x • Driver: ${activeRow.driver}`}
                    />
                    <Metric
                        label={`Giá trị DCF (${useStoreDCF ? "store-driven" : "CAGR"})`}
                        value={`${nf0.format(blendedValue.dcfV)} đ/cp`}
                        sub={`WACC ${pct1.format(dcf.inp.wacc)} • margin ${pct1.format(ebitMargin)} • gT ${pct1.format(gT)}${useStoreDCF && storeDCF ? ` • Implied CAGR ~ ${pct1.format(storeDCF.impliedCAGR)}` : ` • CAGR ${pct1.format(cagr)}`}`}
                    />
                    <Metric label={`Giá trị P/B (${nf1.format(pbMultiple)}x)`} value={`${nf0.format(blendedValue.pbV)} đ/cp`} sub={`BVPS ~ ${nf0.format(bvps)} đ/cp`} />
                </div>

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Metric
                        label="Blended fair value"
                        value={`${nf0.format(blendedValue.v)} đ/cp`}
                        sub={`Upside: ${pct1.format(blendedValue.up)} so với giá hiện tại`}
                        valueClassName="text-indigo-600 dark:text-indigo-400 font-bold text-2xl"
                    />
                    <Metric label="Giá hiện tại" value={`${nf0.format(price)} đ/cp`} sub={`Forward P/E (plan EPS): ${nf2.format(forwardPE)}x`} />
                    <Metric
                        label="Upside (Blended)"
                        value={`${pct1.format(blendedValue.up)}`}
                        sub={`Mkt cap ${nf1.format(mktCapBn)} • Net cash ${nf1.format(netCash)} bn`}
                        valueClassName={blendedValue.up >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}
                    />
                </div>
            </CardContent>
        </Card>
    );

    const InputsPanel = () => (
        <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Inputs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <NumberInput label="Giá hiện tại" value={price} onChange={(v) => setPrice(Math.floor(v))} step={1} suffix="đ" min={0} />
                    <NumberInput label="Số CP (shares)" value={shares} onChange={(v) => setShares(Math.floor(v))} step={1} min={0} />
                    <NumberInput label="LNST kế hoạch (FY2025)" value={planNPAT} onChange={setPlanNPAT} step={0.01} suffix="bn" min={0} />
                    <NumberInput label="LNST 9T (bn)" value={npat9m} onChange={setNpat9m} step={0.01} suffix="bn" min={0} />
                    <NumberInput label="Doanh thu kế hoạch (FY2025)" value={planRevenue} onChange={setPlanRevenue} step={0.01} suffix="bn" min={0} />
                    <NumberInput label="P/B multiple" value={pbMultiple} onChange={setPbMultiple} step={0.1} min={0} />
                </div>

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <NumberInput label="Cash" value={cash} onChange={setCash} step={0.01} suffix="bn" />
                    <NumberInput label="HTM" value={htm} onChange={setHtm} step={0.01} suffix="bn" />
                    <NumberInput label="Borrow" value={borrow} onChange={setBorrow} step={0.01} suffix="bn" />
                    <NumberInput label="Total equity" value={totalEquity} onChange={setTotalEquity} step={0.01} suffix="bn" />
                </div>

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <PercentSlider label="Thuế (tax)" value={tax} min={0.05} max={0.35} step={0.5} onChange={setTax} />
                    <PercentSlider label="EBIT margin" value={ebitMargin} min={0.03} max={0.15} step={0.5} onChange={setEbitMargin} />
                    <PercentSlider label="CAGR 2026-2030 (fallback)" value={cagr} min={0.0} max={0.2} step={0.5} onChange={setCagr} hint="Chỉ dùng khi tắt store-driven DCF." />
                    <PercentSlider label="Terminal g" value={gT} min={0.0} max={0.06} step={0.1} onChange={setGT} />
                    <PercentSlider label="ROC" value={roc} min={0.05} max={0.35} step={0.5} onChange={setRoc} />
                    <PercentSlider label="WACC" value={wacc} min={0.05} max={0.18} step={0.5} onChange={setWacc} hint="Tự guard wacc >= gT + 0.5% trong tính DCF." />
                </div>

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <PercentSlider label="rf" value={rf} min={0.0} max={0.08} step={0.1} onChange={setRf} />
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label className="text-sm">beta</Label>
                            <Badge variant="secondary">{nf2.format(beta)}x</Badge>
                        </div>
                        <Slider value={[beta]} min={0.1} max={1.5} step={0.01} onValueChange={(v) => setBeta(v[0])} />
                    </div>
                    <PercentSlider label="ERP" value={erp} min={0.03} max={0.12} step={0.1} onChange={setErp} />
                </div>

                <div className="rounded-2xl border p-3 bg-muted/30 text-xs text-muted-foreground">
                    Cost of equity (CAPM) ~ <b>{pct1.format(costOfEquity)}</b>
                </div>
            </CardContent>
        </Card>
    );

    const StoreTrackerPanel = () => (
        <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Theo dõi số cửa hàng (theo quý)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <NumberInput label="Baseline (start stores)" value={startStores} onChange={(v) => setStartStores(Math.floor(v))} step={1} min={0} />
                    <NumberInput label="Plan mở ròng (12M)" value={baseNetNewStores} onChange={(v) => setBaseNetNewStores(Math.floor(v))} step={1} min={0} />
                </div>

                <div className="rounded-2xl border p-3 bg-muted/30 text-xs text-muted-foreground">
                    Latest actual (filled): <b>{nf0.format(latestActualStores)}</b> • Chênh vs baseline: <b>{nf0.format(latestActualStores - startStores)}</b>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {QUARTERS_12M.map((q, idx) => (
                        <div key={q} className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">{q} actual</Label>
                            <Input
                                type="number"
                                value={Number.isFinite(actualStoresByQuarter[idx]) ? actualStoresByQuarter[idx] : ""}
                                placeholder="—"
                                onChange={(e) => {
                                    const v = e.target.value.trim();
                                    setActualStoresByQuarter((prev) => {
                                        const next = [...prev];
                                        next[idx] = v === "" ? NaN : Math.floor(safeNum(v));
                                        return next;
                                    });
                                }}
                            />
                        </div>
                    ))}
                </div>

                <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={storeTrackerSeries}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="quarter" />
                            <YAxis tickFormatter={(v) => nf0.format(safeNum(v))} />
                            <Tooltip
                                formatter={(value: unknown, name: unknown) => [
                                    `${nf0.format(safeNum(value))}`,
                                    name === "planned" ? "Plan" : "Actual",
                                ]}
                            />
                            <Legend />
                            <Line type="monotone" dataKey="planned" name="Plan" dot={false} />
                            <Line type="monotone" dataKey="actual" name="Actual" dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>

                <div className="rounded-2xl border overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead className="bg-muted/40">
                                <tr>
                                    <th className="p-2 text-left">Quý</th>
                                    <th className="p-2 text-right">Plan end</th>
                                    <th className="p-2 text-right">Actual</th>
                                    <th className="p-2 text-right">Gap</th>
                                </tr>
                            </thead>
                            <tbody>
                                {QUARTERS_12M.map((q, idx) => {
                                    const p = basePlanStoresByQuarter[idx]?.plannedEndStores ?? NaN;
                                    const a = actualStoresByQuarter[idx];
                                    const gap = Number.isFinite(a) && Number.isFinite(p) ? a - p : NaN;
                                    return (
                                        <tr key={q} className="border-t">
                                            <td className="p-2 text-left">{q}</td>
                                            <td className="p-2 text-right">{Number.isFinite(p) ? nf0.format(p) : "—"}</td>
                                            <td className="p-2 text-right">{Number.isFinite(a) ? nf0.format(a) : "—"}</td>
                                            <td className={`p-2 text-right ${Number.isFinite(gap) ? (gap >= 0 ? "text-emerald-600" : "text-rose-600") : ""}`}>
                                                {Number.isFinite(gap) ? nf0.format(gap) : "—"}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </CardContent>
        </Card>
    );

    const DCFPanel = () => (
        <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">DCF (FCFF) – Base</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="rounded-2xl border p-3 bg-muted/30">
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">DCF revenue dùng driver số cửa hàng</div>
                        <Switch checked={useStoreDCF} onCheckedChange={setUseStoreDCF} />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground leading-relaxed">
                        Khi bật: Revenue 2026–2030 được build từ <b>cửa hàng (kịch bản Bear/Base/Bull)</b> + <b>SSSG (absolute)</b> + <b>% doanh thu retail</b>. Khi tắt: dùng CAGR thuần.
                    </div>
                </div>

                {useStoreDCF ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <PercentSlider
                            label="% doanh thu gắn với cửa hàng (retail share)"
                            value={retailShareDCF}
                            min={0.5}
                            max={1.0}
                            step={1}
                            onChange={setRetailShareDCF}
                            hint="Ví dụ: 85% nghĩa là 85% doanh thu tăng theo stores+SSSG; phần còn lại tăng theo 'other CAGR'."
                        />
                        <PercentSlider
                            label="SSSG cơ sở (absolute, mỗi năm)"
                            value={baseSSSG_DCF}
                            min={0.0}
                            max={0.12}
                            step={0.2}
                            onChange={setBaseSSSG_DCF}
                            hint="SSSG theo kịch bản = SSSG cơ sở + SSSG Δ (Bear/Base/Bull)."
                        />
                        <PercentSlider
                            label="Other CAGR (phần doanh thu không theo cửa hàng)"
                            value={otherCagrDCF}
                            min={-0.02}
                            max={0.12}
                            step={0.2}
                            onChange={setOtherCagrDCF}
                            hint="Ví dụ: bán sỉ/online/khác."
                        />
                        <div className="rounded-2xl border p-3">
                            <div className="text-sm text-muted-foreground">Driver kịch bản đang chọn</div>
                            <div className="mt-1 text-lg font-semibold">{activeScenario}</div>
                            <div className="mt-2 text-xs text-muted-foreground space-y-1">
                                <div>
                                    Store start (DCF): <b>{nf0.format(dcfStoreCfg.storeStart)}</b>
                                </div>
                                <div>
                                    Net new / year: <b>{nf0.format(dcfStoreCfg.netNewPerYear)}</b>
                                </div>
                                <div>
                                    Ramp: <b>{pct0.format(dcfStoreCfg.ramp)}</b>
                                </div>
                                <div>
                                    SSSG (abs): <b>{pct1.format(clamp(dcfStoreCfg.sssgAbs, -0.05, 0.2))}</b>
                                </div>
                                <div>
                                    Implied CAGR 26–30: <b>{storeDCF ? pct1.format(storeDCF.impliedCAGR) : "—"}</b>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Metric
                        label="EV (DCF)"
                        value={`${nf1.format(dcf.out.ev_bn)} bn`}
                        sub={`PV FCFF ${nf1.format(dcf.out.pvFCFF)} • PV TV ${nf1.format(dcf.out.pvTV)}`}
                    />
                    <Metric label="Equity value" value={`${nf1.format(dcf.out.eq_bn)} bn`} sub={`+ Net cash ${nf1.format(netCash)} bn`} />
                    <Metric label="DCF value / share" value={`${nf0.format(dcf.out.vps)} đ/cp`} sub={`WACC ${pct1.format(dcf.inp.wacc)} • gT ${pct1.format(gT)}`} />
                </div>

                {useStoreDCF && storeDCF ? (
                    <div className="rounded-2xl border overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead className="bg-muted/40">
                                    <tr>
                                        <th className="p-2 text-left">Năm</th>
                                        <th className="p-2 text-right">Start</th>
                                        <th className="p-2 text-right">Net new</th>
                                        <th className="p-2 text-right">End</th>
                                        <th className="p-2 text-right">Avg eff</th>
                                        <th className="p-2 text-right">Retail DT</th>
                                        <th className="p-2 text-right">Other DT</th>
                                        <th className="p-2 text-right">Total DT</th>
                                        <th className="p-2 text-right">YoY</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {storeDCF.rows.map((r) => (
                                        <tr key={r.year} className="border-t">
                                            <td className="p-2 text-left">{r.year}</td>
                                            <td className="p-2 text-right">{nf0.format(r.storesStart)}</td>
                                            <td className="p-2 text-right">{nf0.format(dcfStoreCfg.netNewPerYear)}</td>
                                            <td className="p-2 text-right">{nf0.format(r.storesEnd)}</td>
                                            <td className="p-2 text-right">{nf0.format(r.avgStoresEff)}</td>
                                            <td className="p-2 text-right">{nf1.format(r.retailRev_bn)}</td>
                                            <td className="p-2 text-right">{nf1.format(r.otherRev_bn)}</td>
                                            <td className="p-2 text-right">{nf1.format(r.revenue_bn)}</td>
                                            <td className="p-2 text-right">{pct1.format(r.yoy)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : null}

                <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={dcfSeries}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="year" />
                            <YAxis tickFormatter={(v) => nf1.format(safeNum(v))} />
                            <Tooltip
                                formatter={(value: unknown, name: unknown) => [
                                    `${nf1.format(safeNum(value))} bn`,
                                    typeof name === "string" ? name : String(name ?? ""),
                                ]}
                            />
                            <Legend />
                            <Line type="monotone" dataKey="revenue" name="Revenue" dot={false} />
                            <Line type="monotone" dataKey="fcff" name="FCFF" dot={false} />
                            <Line type="monotone" dataKey="pv" name="PV(FCFF)" dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>

                <div className="rounded-2xl border overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead className="bg-muted/40">
                                <tr>
                                    <th className="p-2 text-left">Năm</th>
                                    <th className="p-2 text-right">Revenue (bn)</th>
                                    <th className="p-2 text-right">YoY</th>
                                    <th className="p-2 text-right">EBIT (bn)</th>
                                    <th className="p-2 text-right">NOPAT (bn)</th>
                                    <th className="p-2 text-right">Reinv</th>
                                    <th className="p-2 text-right">FCFF (bn)</th>
                                    <th className="p-2 text-right">Disc</th>
                                    <th className="p-2 text-right">PV (bn)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {dcf.out.rows.map((r) => (
                                    <tr key={r.y} className="border-t">
                                        <td className="p-2 text-left">{r.y}</td>
                                        <td className="p-2 text-right">{nf1.format(r.rev)}</td>
                                        <td className="p-2 text-right">{pct1.format(r.g)}</td>
                                        <td className="p-2 text-right">{nf1.format(r.ebit)}</td>
                                        <td className="p-2 text-right">{nf1.format(r.nopat)}</td>
                                        <td className="p-2 text-right">{pct1.format(r.reinvRate)}</td>
                                        <td className="p-2 text-right">{nf1.format(r.fcff)}</td>
                                        <td className="p-2 text-right">{nf2.format(r.disc)}</td>
                                        <td className="p-2 text-right">{nf1.format(r.pv)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </CardContent>
        </Card>
    );

    const NotesPanel = () => (
        <div className="space-y-6">
            <Card className="rounded-2xl shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Ghi chú giả định (định lượng rõ ràng)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <Card className="rounded-2xl shadow-sm">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm">Kịch bản Bear / Base / Bull (P/E)</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="text-xs text-muted-foreground">Mỗi kịch bản gồm <b>2 nút</b>: (1) EPS% so với kế hoạch (tức LNST 2025), (2) P/E mục tiêu.</div>

                                <div className="space-y-3">
                                    {scenarioTable.map((r) => (
                                        <div key={r.name} className="rounded-2xl border p-3">
                                            <div className="flex items-center justify-between">
                                                <div className="text-sm font-semibold">{r.name}</div>
                                                <Badge variant={r.name === activeScenario ? "default" : "secondary"}>TP {nf0.format(r.tp)}</Badge>
                                            </div>

                                            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                                <div className="space-y-1">
                                                    <div>
                                                        EPS vs plan: <b>{pct1.format(r.epsVsPlan)}</b>
                                                    </div>
                                                    <div>
                                                        LNST 2025: <b>{nf1.format(r.npat)} bn</b>
                                                    </div>
                                                    <div>
                                                        Upside: <b>{pct1.format(r.upside)}</b>
                                                    </div>
                                                </div>
                                                <div className="space-y-1">
                                                    <div>
                                                        P/E: <b>{nf1.format(r.pe)}x</b>
                                                    </div>
                                                    <div>
                                                        EPS: <b>{nf0.format(r.eps)} đ</b>
                                                    </div>
                                                    <div>
                                                        Q4 cần: <b>{nf1.format(r.q4Req)} bn</b>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="rounded-2xl shadow-sm">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm">DCF (FCFF) – giả định cốt lõi</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="text-xs text-muted-foreground">
                                    DCF dùng để <b>cross-check</b>. Khi bật <b>store-driven DCF</b>, revenue 2026–2030 phản ánh trực tiếp số cửa hàng theo kịch bản.
                                </div>

                                <div className="rounded-2xl border p-3">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                                        <div className="space-y-1">
                                            <div>
                                                DT 2025: <b>{nf0.format(planRevenue)} bn</b>
                                            </div>
                                            <div>
                                                WACC: <b>{pct0.format(dcf.inp.wacc)}</b>
                                            </div>
                                            <div>
                                                gT: <b>{pct0.format(gT)}</b>
                                            </div>
                                            <div>
                                                Net cash: <b>{nf1.format(netCash)} bn</b>
                                            </div>
                                        </div>

                                        <div className="space-y-1">
                                            <div>
                                                EBIT margin: <b>{pct0.format(ebitMargin)}</b>
                                            </div>
                                            <div>
                                                Tax: <b>{pct0.format(tax)}</b>
                                            </div>
                                            <div>
                                                ROC: <b>{pct0.format(roc)}</b>
                                            </div>
                                            <div>
                                                DCF value/share: <b>{nf0.format(dcf.out.vps)} đ/cp</b>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="text-xs text-muted-foreground leading-relaxed">
                                    Công thức chính: <b>FCFF = NOPAT × (1 − reinvest)</b>, với reinvest ≈ min(95%, g/ROC). Terminal: <b>TV = FCFF2031/(WACC − gT)</b>.
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="rounded-2xl shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">CAPM (tham khảo) & gợi ý kiểm tra hợp lý</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <Metric label="rf" value={pct1.format(rf)} />
                                <Metric label="beta" value={nf2.format(beta)} />
                                <Metric label="ERP" value={pct1.format(erp)} />
                                <Metric label="Cost of equity" value={pct1.format(costOfEquity)} />
                            </div>
                            <div className="text-xs text-muted-foreground">Nếu <b>Cost of equity</b> lệch xa <b>WACC</b> bạn đang dùng, hãy cân nhắc chỉnh WACC hoặc giải thích phần debt/structure.</div>
                        </CardContent>
                    </Card>

                    <Card className="rounded-2xl shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Inputs chi tiết (P/B, Bảng cân đối, CAPM)</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <Metric label="P/B multiple" value={`${nf1.format(pbMultiple)}x`} />
                                <Metric label="BVPS" value={`${nf0.format(bvps)} đ/cp`} />
                                <Metric label="P/B implied" value={`${nf2.format(pbImplied)}x`} />
                            </div>

                            <Separator />

                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <Metric label="Tiền (bn)" value={nf1.format(cash)} />
                                <Metric label="ĐT nắm giữ (HTM) (bn)" value={nf1.format(htm)} />
                                <Metric label="Vay (bn)" value={nf1.format(borrow)} />
                                <Metric label="VCSH (bn)" value={nf1.format(totalEquity)} />
                            </div>

                            <div className="rounded-2xl border p-3 bg-muted/30 text-xs text-muted-foreground">
                                Gợi ý kiểm tra nhanh: (1) Net cash nên khớp gần đúng với BCTC; (2) P/B multiple nên phản ánh ROE/chu kỳ; (3) Cost of equity chỉ là tham khảo cho WACC.
                            </div>
                        </CardContent>
                    </Card>
                </CardContent>
            </Card>
        </div>
    );


    return (
        <div className="min-h-screen w-full bg-background p-4 md:p-6">
            <div className="mx-auto max-w-7xl space-y-6">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                        <div className="text-2xl font-semibold">PNJ VN – Dashboard định giá (P/E + DCF + P/B)</div>
                        <div className="mt-1 text-sm text-muted-foreground">Chỉnh giả định → tự cập nhật giá mục tiêu, upside, và blended fair value.</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={resetDefaults} className="gap-2">
                            <RefreshCw className="h-4 w-4" />
                            Reset mặc định
                        </Button>
                    </div>
                </div>

                <Tabs defaultValue="overview" className="w-full">
                    <TabsList className="w-full justify-start">
                        <TabsTrigger value="overview">Tổng quan</TabsTrigger>
                        <TabsTrigger value="inputs">Inputs</TabsTrigger>
                        <TabsTrigger value="stores">Stores</TabsTrigger>
                        <TabsTrigger value="dcf">DCF</TabsTrigger>
                        <TabsTrigger value="notes">Ghi chú giả định</TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="mt-6">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-2 space-y-6">
                                <Card className="rounded-2xl shadow-sm">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-base">Tổng quan kịch bản (P/E framework)</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-4">
                                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                            <Metric
                                                label="Plan EPS (FY2025)"
                                                value={`${nf0.format(planEPS)} đ/cp`}
                                                sub={`LNST plan: ${nf1.format(planNPAT)} bn • CP: ${nf0.format(shares)}`}
                                                valueClassName="text-blue-600 dark:text-blue-400"
                                            />
                                            <Metric label="Giá hiện tại" value={`${nf0.format(price)} đ/cp`} sub={`Forward P/E (plan): ${nf2.format(forwardPE)}x`} />
                                            <Metric
                                                label="Net cash (tham khảo)"
                                                value={`${nf1.format(netCash)} bn`}
                                                sub={`Tiền ${nf1.format(cash)} + HTM ${nf1.format(htm)} − Vay ${nf1.format(borrow)}`}
                                                valueClassName="text-emerald-600 dark:text-emerald-400"
                                            />
                                            <Metric
                                                label="LNST Q4 cần đạt"
                                                value={`${nf1.format(activeRow.q4Req)} bn`}
                                                sub={`Để đạt kịch bản ${activeScenario} (từ 9M: ${nf1.format(npat9m)} bn)`}
                                                valueClassName={activeRow.q4Req > 0 ? "text-orange-600 dark:text-orange-400" : ""}
                                            />
                                        </div>

                                        {useStoreKPI ? (
                                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                                <Metric
                                                    label="Store KPI (baseline)"
                                                    value={`${nf0.format(startStores)} cửa hàng`}
                                                    sub={`Plan mở ròng: ${nf0.format(baseNetNewStores)} • Ramp: ${pct0.format(newStoreRamp)}`}
                                                />
                                                <Metric
                                                    label="Actual stores (latest filled)"
                                                    value={`${nf0.format(latestActualStores)} cửa hàng`}
                                                    sub={`Chênh vs baseline: ${nf0.format(latestActualStores - startStores)} cửa hàng`}
                                                    valueClassName={
                                                        latestActualStores >= startStores ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                                                    }
                                                />
                                                <Metric
                                                    label="Driver kịch bản đang chọn"
                                                    value={`SSSG ${pct1.format(Number.isFinite(activeRow.sssgDelta) ? activeRow.sssgDelta : 0)}`}
                                                    sub={`End stores: ${Number.isFinite(activeRow.storesEnd) ? nf0.format(activeRow.storesEnd) : "—"} • Avg eff: ${Number.isFinite(activeRow.avgStoresEff) ? nf0.format(activeRow.avgStoresEff) : "—"
                                                        }`}
                                                />
                                                <Metric
                                                    label="Revenue (kịch bản)"
                                                    value={Number.isFinite(activeRow.revenue_bn) ? `${nf1.format(activeRow.revenue_bn)} bn` : "—"}
                                                    sub="Neo theo kế hoạch 2025 (scale theo stores + SSSG)"
                                                />
                                            </div>
                                        ) : null}

                                        <div className="h-72">
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={scenarioChartData}>
                                                    <CartesianGrid strokeDasharray="3 3" />
                                                    <XAxis dataKey="scenario" />
                                                    <YAxis tickFormatter={(v) => nf0.format(safeNum(v))} />
                                                    <Tooltip
                                                        formatter={(value: unknown) => [`${nf0.format(safeNum(value))} đ/cp`, "Giá mục tiêu"]}
                                                    />
                                                    <Legend />
                                                    <Bar dataKey="target" name="Giá mục tiêu" />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>

                                        <div className="rounded-2xl border overflow-hidden">
                                            <div className="overflow-x-auto">
                                                <table className="w-full table-fixed text-xs">
                                                    <thead className="bg-muted/40">
                                                        <tr className="font-medium">
                                                            <th className="p-2 w-[80px] text-left whitespace-nowrap">Kịch bản</th>
                                                            <th className="p-2 w-[90px] text-left whitespace-nowrap">Driver</th>
                                                            <th className="p-2 w-[100px] text-right whitespace-nowrap">EPS vs plan</th>
                                                            <th className="p-2 w-[70px] text-right whitespace-nowrap">P/E</th>
                                                            <th className="p-2 w-[120px] text-right whitespace-nowrap">LNST (bn)</th>
                                                            <th className="p-2 w-[110px] text-right whitespace-nowrap">EPS (đ)</th>
                                                            <th className="p-2 w-[140px] text-right whitespace-nowrap">Giá mục tiêu (đ)</th>
                                                            <th className="p-2 w-[90px] text-right whitespace-nowrap">Upside</th>
                                                            {useStoreKPI ? (
                                                                <>
                                                                    <th className="p-2 w-[90px] text-right whitespace-nowrap">Start</th>
                                                                    <th className="p-2 w-[90px] text-right whitespace-nowrap">Net new</th>
                                                                    <th className="p-2 w-[90px] text-right whitespace-nowrap">End</th>
                                                                    <th className="p-2 w-[90px] text-right whitespace-nowrap">SSSG Δ</th>
                                                                    <th className="p-2 w-[120px] text-right whitespace-nowrap">Revenue (bn)</th>
                                                                </>
                                                            ) : null}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {scenarioTable.map((r) => (
                                                            <tr
                                                                key={r.name}
                                                                onClick={() => setActiveScenario(r.name)}
                                                                className={`border-t hover:bg-muted/30 cursor-pointer ${activeScenario === r.name ? "bg-muted/40" : "bg-background"}`}
                                                            >
                                                                <td className="p-2 text-left font-medium whitespace-nowrap">{r.name}</td>
                                                                <td className="p-2 text-left whitespace-nowrap">{r.driver}</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{pct1.format(r.epsVsPlan)}</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{nf1.format(r.pe)}x</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{nf1.format(r.npat)}</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{nf0.format(r.eps)}</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{nf0.format(r.tp)}</td>
                                                                <td className="p-2 text-right whitespace-nowrap">{pct1.format(r.upside)}</td>
                                                                {useStoreKPI ? (
                                                                    <>
                                                                        <td className="p-2 text-right whitespace-nowrap">{Number.isFinite(r.storesStart) ? nf0.format(r.storesStart) : "—"}</td>
                                                                        <td className="p-2 text-right whitespace-nowrap">{Number.isFinite(r.netNewStores) ? nf0.format(r.netNewStores) : "—"}</td>
                                                                        <td className="p-2 text-right whitespace-nowrap">{Number.isFinite(r.storesEnd) ? nf0.format(r.storesEnd) : "—"}</td>
                                                                        <td className="p-2 text-right whitespace-nowrap">{Number.isFinite(r.sssgDelta) ? pct1.format(r.sssgDelta) : "—"}</td>
                                                                        <td className="p-2 text-right whitespace-nowrap">{Number.isFinite(r.revenue_bn) ? nf1.format(r.revenue_bn) : "—"}</td>
                                                                    </>
                                                                ) : null}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>

                                <DCFPanel />
                            </div>

                            <div className="space-y-6">
                                <ScenarioEditor />
                                <WeightsPanel />
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="inputs" className="mt-6">
                        <InputsPanel />
                    </TabsContent>

                    <TabsContent value="stores" className="mt-6">
                        <StoreTrackerPanel />
                    </TabsContent>

                    <TabsContent value="dcf" className="mt-6">
                        <DCFPanel />
                    </TabsContent>

                    <TabsContent value="notes" className="mt-6">
                        <NotesPanel />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}

