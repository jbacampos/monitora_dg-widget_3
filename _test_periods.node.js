// ============================================================
// HARNESS DE TESTE (Node) — não faz parte do widget.
// Carrega script.js em sandbox e valida a reconstrução dos
// períodos ON, as totalizações por dia/mês e o percentual.
// Executar com TZ=UTC para resultado determinístico:
//   $env:TZ='UTC'; node _test_periods.node.js
// ============================================================

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

const ID = "7e62cc00-c0df-11f1-8ef7-dd61fc2d324e";
const D = s => Date.parse(s);
const iso = ts => new Date(ts).toISOString();

// --- Relógio fixo ---------------------------------------------------
const NOW = D("2026-10-07T20:35:00Z");
let fakeNow = NOW;
Date.now = () => fakeNow;

// --- Série histórica simulada (por chave) ---------------------------
const seriesByKey = {
    rede_disponivel: [
        { ts: D("2026-10-05T00:00:00Z"), value: "1" },
        { ts: D("2026-10-05T10:00:00Z"), value: "0" },
        { ts: D("2026-10-05T12:00:00Z"), value: "1" },
        { ts: D("2026-10-06T02:00:00Z"), value: "0" },
        { ts: D("2026-10-06T09:11:00Z"), value: "1" },
        { ts: D("2026-10-06T12:23:00Z"), value: "0" },
        { ts: D("2026-10-07T09:00:00Z"), value: "1" }
    ],
    alimentacao_offgrid: [
        { ts: D("2026-10-05T00:00:00Z"), value: "0" },
        { ts: D("2026-10-06T08:00:00Z"), value: "1" },
        { ts: D("2026-10-06T10:30:00Z"), value: "0" }
    ],
    alimentacao_gerador: [
        { ts: D("2025-12-15T00:00:00Z"), value: "1" },
        { ts: D("2025-12-16T00:00:00Z"), value: "0" },
        { ts: D("2026-02-01T00:00:00Z"), value: "1" },
        { ts: D("2026-02-01T12:00:00Z"), value: "0" }
    ]
};

// --- DOM / ctx simulados -------------------------------------------
const elements = {};
function makeEl(id) {
    return {
        id: id,
        innerHTML: "",
        textContent: "",
        value: id === "periodSelect" ? "ultimos3dias" : undefined,
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        addEventListener() {},
        querySelectorAll() { return []; }
    };
}
const container = {
    querySelector(sel) {
        const id = sel.replace("#", "");
        if (!elements[id]) { elements[id] = makeEl(id); }
        return elements[id];
    }
};

function keyFromUrl(url) {
    const m = /keys=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
}

let httpCalls = 0;
let onDataUpdated = null;
let destroyCallback = null;

const ctx = {
    http: {
        get: url => ({
            subscribe: ok => {
                httpCalls++;
                const k = keyFromUrl(url);
                ok(k ? { [k]: seriesByKey[k] || [] } : {});
                return { unsubscribe() {} };
            }
        })
    },
    subscriptionApi: {
        createSubscription: options => ({
            subscribe: fn => {
                if (options && options.callbacks) {
                    onDataUpdated = options.callbacks.onDataUpdated;
                }
                fn({ id: "test-sub", data: [] });
                return { unsubscribe() {} };
            }
        })
    },
    registerDestroyCallback: fn => { destroyCallback = fn; }
};

let setIntervalCount = 0;
let clearIntervalCount = 0;
let intervalDelay = null;
const intervalFns = [];
global.setInterval = function (fn, delay) {
    setIntervalCount++;
    intervalDelay = delay;
    intervalFns.push(fn);
    return { id: setIntervalCount };
};
global.clearInterval = function () { clearIntervalCount++; };

global.container = container;
global.ctx = ctx;

vm.runInThisContext(src, { filename: "script.js" });

// --- assertivas -----------------------------------------------------
let passed = 0;
let failed = 0;
function check(label, actual, expected) {
    if (actual === expected) {
        passed++;
        console.log("PASS  " + label + "  =>  " + actual);
    } else {
        failed++;
        console.log("FAIL  " + label +
            "  => obtido [" + actual + "] esperado [" + expected + "]");
    }
}
function checkTrue(label, cond, detail) {
    check(label, cond ? "true" : "false", "true");
    if (!cond && detail !== undefined) { console.log("      " + detail); }
}

const settle = () => new Promise(r => setTimeout(r, 25));
const mins = h => h * 3600000;

const pt = (s, v) => ({ ts: D(s), value: v });
const ivStr = iv => iso(iv[0]) + " .. " + iso(iv[1]);

// ============================================================
// (A) Formatação / percentual
// ============================================================
function groupFormat() {
    console.log("\n== (A) Formatação e percentual ==");
    check("dur 0", formatDuration(0), "0m");
    check("dur 37m", formatDuration(37 * 60000), "37m");
    check("dur 8:33", formatDuration((8 * 60 + 33) * 60000), "8:33");
    check("dur 62:42", formatDuration((62 * 60 + 42) * 60000), "62:42");
    check("dur 24:00", formatDuration(24 * 3600000), "24:00");
    check("mes 0 -> 0:00", formatMonthTotal(0), "0:00");
    check("mes 142:37", formatMonthTotal((142 * 60 + 37) * 60000), "142:37");
    check("pct 87,1", formatPercent((62 * 60 + 42) * 60000, 72 * 3600000), "87,1%");
    check("pct 0", formatPercent(0, 72 * 3600000), "0,0%");
    check("range ate meia-noite",
        formatRange(D("2026-10-06T23:00:00Z"), D("2026-10-07T00:00:00Z"), false),
        "23:00 - 24:00");
    check("range em andamento",
        formatRange(D("2026-10-07T09:00:00Z"), D("2026-10-07T20:35:00Z"), true),
        "09:00 - agora");
    check("range simples",
        formatRange(D("2026-10-07T09:11:00Z"), D("2026-10-07T12:23:00Z"), false),
        "09:11 - 12:23");
}

// ============================================================
// (B) Janelas de período
// ============================================================
function groupWindows() {
    console.log("\n== (B) Intervalos dos períodos ==");
    check("hoje inicio", iso(computeWindow("hoje", NOW).start), "2026-10-07T00:00:00.000Z");
    check("hoje liveEnd", String(computeWindow("hoje", NOW).liveEnd), "true");
    check("ontem inicio", iso(computeWindow("ontem", NOW).start), "2026-10-06T00:00:00.000Z");
    check("ontem fim", iso(computeWindow("ontem", NOW).end), "2026-10-07T00:00:00.000Z");
    check("ult3 inicio", iso(computeWindow("ultimos3dias", NOW).start), "2026-10-05T00:00:00.000Z");
    check("ult7 inicio", iso(computeWindow("ultimos7dias", NOW).start), "2026-10-01T00:00:00.000Z");
    check("esta semana (dom)", iso(computeWindow("estasemana", NOW).start), "2026-10-04T00:00:00.000Z");
    check("semana passada inicio", iso(computeWindow("semanapassada", NOW).start), "2026-09-27T00:00:00.000Z");
    check("semana passada fim", iso(computeWindow("semanapassada", NOW).end), "2026-10-04T00:00:00.000Z");
    check("este mes inicio", iso(computeWindow("estemes", NOW).start), "2026-10-01T00:00:00.000Z");
    check("mes passado inicio", iso(computeWindow("mespassado", NOW).start), "2026-09-01T00:00:00.000Z");
    check("mes passado fim", iso(computeWindow("mespassado", NOW).end), "2026-10-01T00:00:00.000Z");
    check("este ano inicio", iso(computeWindow("esteano", NOW).start), "2026-01-01T00:00:00.000Z");
    check("ano passado inicio", iso(computeWindow("anopassado", NOW).start), "2025-01-01T00:00:00.000Z");
    check("ano passado fim", iso(computeWindow("anopassado", NOW).end), "2026-01-01T00:00:00.000Z");
    check("ano -> modo mes", computeWindow("esteano", NOW).mode, "month");
    check("desde inicio start", String(computeWindow("desdeoinicio", NOW).start), "null");
    check("desde inicio modo", computeWindow("desdeoinicio", NOW).mode, "month");
}

// ============================================================
// (C) Reconstrução dos intervalos ON
// ============================================================
function groupIntervals() {
    console.log("\n== (C) Reconstrução dos períodos ON ==");
    const w0 = D("2026-10-07T00:00:00Z");
    const w1 = D("2026-10-07T23:59:00Z");

    let r = buildOnIntervals(
        [pt("2026-10-07T09:11:00Z", "1"), pt("2026-10-07T12:23:00Z", "0")], w0, w1);
    check("simples: 1 periodo", String(r.intervals.length), "1");
    check("simples: intervalo", ivStr(r.intervals[0]),
        "2026-10-07T09:11:00.000Z .. 2026-10-07T12:23:00.000Z");
    check("simples: onAtEnd", String(r.onAtEnd), "false");

    r = buildOnIntervals([
        pt("2026-10-07T00:00:00Z", "1"), pt("2026-10-07T08:33:00Z", "0"),
        pt("2026-10-07T09:11:00Z", "1"), pt("2026-10-07T12:23:00Z", "0"),
        pt("2026-10-07T13:02:00Z", "1"), pt("2026-10-07T15:59:00Z", "0")
    ], w0, w1);
    check("multiplos: 3 periodos", String(r.intervals.length), "3");

    // Estado ON no início da janela (ponto anterior à janela).
    r = buildOnIntervals(
        [pt("2026-10-06T22:00:00Z", "1"), pt("2026-10-07T05:00:00Z", "0")],
        D("2026-10-07T02:00:00Z"), D("2026-10-07T23:59:00Z"));
    check("ON no inicio: comeca na janela", ivStr(r.intervals[0]),
        "2026-10-07T02:00:00.000Z .. 2026-10-07T05:00:00.000Z");

    // Estado ON no fim da janela (em andamento).
    r = buildOnIntervals(
        [pt("2026-10-07T09:00:00Z", "1")], w0, D("2026-10-07T12:00:00Z"));
    check("ON no fim: termina na janela", ivStr(r.intervals[0]),
        "2026-10-07T09:00:00.000Z .. 2026-10-07T12:00:00.000Z");
    check("ON no fim: onAtEnd", String(r.onAtEnd), "true");

    // Somente OFF na janela.
    r = buildOnIntervals(
        [pt("2026-10-07T00:00:00Z", "0"), pt("2026-10-07T12:00:00Z", "0")], w0, w1);
    check("OFF na janela: 0 periodos", String(r.intervals.length), "0");

    // Janela terminando no meio de um período.
    r = buildOnIntervals(
        [pt("2026-10-07T09:00:00Z", "1"), pt("2026-10-07T15:00:00Z", "0")],
        w0, D("2026-10-07T12:00:00Z"));
    check("fim no meio: corta na janela", ivStr(r.intervals[0]),
        "2026-10-07T09:00:00.000Z .. 2026-10-07T12:00:00.000Z");
}

// ============================================================
// (D) Divisão por dia (meia-noite) / totalização diária
// ============================================================
function groupDays() {
    console.log("\n== (D) Divisão por dia / totalização diária ==");
    const days = splitByDay([[
        D("2026-10-06T23:00:00Z"), D("2026-10-07T03:00:00Z")
    ]]);
    check("dias: qtd", String(days.length), "2");
    check("dias: mais recente", iso(days[0].dayStart), "2026-10-07T00:00:00.000Z");
    check("dia 07: segmento", ivStr(days[0].segments[0]),
        "2026-10-07T00:00:00.000Z .. 2026-10-07T03:00:00.000Z");
    check("dia 07: total", formatDuration(days[0].totalMs), "3:00");
    check("dia 06: segmento", ivStr(days[1].segments[0]),
        "2026-10-06T23:00:00.000Z .. 2026-10-07T00:00:00.000Z");
    check("dia 06: total", formatDuration(days[1].totalMs), "1:00");

    // Múltiplos períodos no mesmo dia.
    const d2 = splitByDay([
        [D("2026-10-07T09:11:00Z"), D("2026-10-07T12:23:00Z")],
        [D("2026-10-07T13:02:00Z"), D("2026-10-07T15:59:00Z")]
    ]);
    check("mesmo dia: qtd dias", String(d2.length), "1");
    check("mesmo dia: qtd periodos", String(d2[0].segments.length), "2");
    check("mesmo dia: ordem desc", ivStr(d2[0].segments[0]),
        "2026-10-07T13:02:00.000Z .. 2026-10-07T15:59:00.000Z");
    check("mesmo dia: total", formatDuration(d2[0].totalMs), "6:09");
}

// ============================================================
// (E) Totalização mensal
// ============================================================
function groupMonths() {
    console.log("\n== (E) Totalização mensal ==");
    const months = buildMonthTotals([[
        D("2025-12-30T00:00:00Z"), D("2026-01-02T00:00:00Z")
    ]], D("2025-12-01T00:00:00Z"), D("2026-03-01T00:00:00Z"));
    check("meses: qtd", String(months.length), "3");
    check("mes: mais recente", formatMonthLabel(months[0].monthStart), "Fev/26");
    check("mes: Dez/25", formatMonthTotal(months[2].totalMs), "48:00");
    check("mes: Jan/26", formatMonthTotal(months[1].totalMs), "24:00");
    check("mes: Fev/26 vazio", formatMonthTotal(months[0].totalMs), "0:00");
}

// ============================================================
// (F) Ano bissexto
// ============================================================
function groupLeapYear() {
    console.log("\n== (F) Ano bissexto ==");
    const days = splitByDay([[
        D("2028-02-28T00:00:00Z"), D("2028-03-01T00:00:00Z")
    ]]);
    check("bissexto: qtd dias", String(days.length), "2");
    check("bissexto: 29/02 existe", iso(days[0].dayStart), "2028-02-29T00:00:00.000Z");
    const m = buildMonthTotals([[
        D("2028-02-28T00:00:00Z"), D("2028-03-01T00:00:00Z")
    ]], D("2028-02-01T00:00:00Z"), D("2028-03-01T00:00:00Z"));
    check("bissexto: fev = 48:00", formatMonthTotal(m[0].totalMs), "48:00");
}

// ============================================================
// Leitura do DOM renderizado
// ============================================================
const ROW_RE = /class="p-row(?: p-sum)?"><span class="p-date">([^<]*)<\/span><span class="p-range">([^<]*)<\/span><span class="p-(?:dur|val)"[^>]*>([^<]*)<\/span>/g;

function readDayGroups() {
    const h = elements["periods"].innerHTML;
    return h.split('class="p-group"').slice(1).map(function (g) {
        const rows = [];
        let m;
        ROW_RE.lastIndex = 0;
        while ((m = ROW_RE.exec(g))) {
            rows.push({ date: m[1], range: m[2], val: m[3] });
        }
        return rows;
    });
}

function readMonthRows() {
    const h = elements["periods"].innerHTML;
    const re = /<span class="m-label">([^<]*)<\/span><span class="m-val"[^>]*>([^<]*)<\/span>/g;
    const rows = [];
    let m;
    while ((m = re.exec(h))) {
        rows.push({ label: m[1], val: m[2] });
    }
    return rows;
}

// ============================================================
// (G) Render no modo dia (Últimos 3 dias)
// ============================================================
function groupRenderDay() {
    console.log("\n== (G) Render: modo dia (Últimos 3 dias) ==");
    const g = readDayGroups();

    check("G: qtd dias", String(g.length), "3");
    check("G: dia 07 data", g[0][0].date, "07/10");
    check("G: dia 07 periodo (agora)", g[0][0].range, "09:00 - agora");
    check("G: dia 07 duracao", g[0][0].val, "11:35");
    check("G: dia 07 total", g[0][1].val, "11:35");

    check("G: dia 06 data (1a linha)", g[1][0].date, "06/10");
    check("G: dia 06 periodo 1", g[1][0].range, "09:11 - 12:23");
    check("G: dia 06 dur 1", g[1][0].val, "3:12");
    check("G: dia 06 periodo 2", g[1][1].range, "00:00 - 02:00");
    check("G: dia 06 sem data na 2a linha", g[1][1].date, "");
    check("G: dia 06 total", g[1][2].val, "5:12");

    check("G: dia 05 data", g[2][0].date, "05/10");
    check("G: dia 05 fim meia-noite", g[2][0].range, "12:00 - 24:00");
    check("G: dia 05 total", g[2][2].val, "22:00");

    check("G: total geral", elements["grandTotal"].innerHTML,
        'Total: <span id="live-total-on">38:47</span> / <span id="live-total-dur">68:35</span> = <span id="live-pct">56,5%</span>');
}

// ============================================================
// (I) Timer local (sem novo request)
// ============================================================
function groupTimer() {
    console.log("\n== (I) Timer local ==");
    check("timer: um setInterval", String(setIntervalCount), "1");
    check("timer: intervalo 1000ms", String(intervalDelay), "1000");

    // Durações têm resolução de minuto: 1s não muda o texto; 60s sim.
    fakeNow += 1000;
    if (intervalFns[0]) { intervalFns[0](); }
    check("timer: 1s nao muda (minuto)", elements["live-total-dur"].textContent, "68:35");

    fakeNow += 59000;
    if (intervalFns[0]) { intervalFns[0](); }
    check("timer: duracao viva", elements["live-seg-dur"].textContent, "11:36");
    check("timer: total do dia vivo", elements["live-day-tot"].textContent, "11:36");
    check("timer: total ON vivo", elements["live-total-on"].textContent, "38:48");
    check("timer: duracao da janela", elements["live-total-dur"].textContent, "68:36");
    check("timer: percentual vivo", elements["live-pct"].textContent, "56,6%");
    check("timer: continua um setInterval", String(setIntervalCount), "1");
}

// ============================================================
// (J) Transição ao vivo
// ============================================================
function groupLive() {
    console.log("\n== (J) Transição ao vivo ==");
    const httpBefore = httpCalls;

    fakeNow = D("2026-10-07T20:45:00Z");
    onDataUpdated({ data: [{
        dataKey: { name: "rede_disponivel", type: "timeseries" },
        datasource: { entityFilter: { singleEntity: { id: ID } } },
        data: [[D("2026-10-07T20:40:00Z"), "0"]]
    }] });

    const html = elements["periods"].innerHTML;
    check("live: sem novo http.get", String(httpCalls), String(httpBefore));
    checkTrue("live: nao ha 'agora'", html.indexOf("agora") === -1);
    checkTrue("live: fim 20:40", html.indexOf("09:00 - 20:40") !== -1,
        "html nao contem o novo fim");
    check("live: total geral", elements["grandTotal"].innerHTML,
        'Total: <span id="live-total-on">38:52</span> / <span id="live-total-dur">68:45</span> = <span id="live-pct">56,5%</span>');
}

// ============================================================
// (K) Troca de estado (state picker)
// ============================================================
function groupSwitch() {
    console.log("\n== (K) Troca de estado ==");
    fakeNow = NOW;
    selectState(2);

    return settle().then(function () {
        const g = readDayGroups();
        check("switch: qtd dias", String(g.length), "1");
        check("switch: data", g[0][0].date, "06/10");
        check("switch: periodo", g[0][0].range, "08:00 - 10:30");
        check("switch: duracao", g[0][0].val, "2:30");
        check("switch: total do dia", g[0][1].val, "2:30");
        check("switch: total geral", elements["grandTotal"].innerHTML,
            'Total: <span id="live-total-on">2:30</span> / <span id="live-total-dur">68:35</span> = <span id="live-pct">3,6%</span>');
    });
}

// ============================================================
// (L) Desde o início (modo mês)
// ============================================================
function groupSince() {
    console.log("\n== (L) Desde o início (modo mês) ==");
    elements["periodSelect"].value = "desdeoinicio";
    setupControls();
    selectState(3);

    return settle().then(function () {
        const rows = readMonthRows();
        check("desde: qtd meses", String(rows.length), "11");
        check("desde: mais recente", rows[0].label, "Out/26");
        check("desde: mais antigo", rows[rows.length - 1].label, "Dez/25");

        const find = l => (rows.filter(r => r.label === l)[0] || {}).val;
        check("desde: Dez/25", find("Dez/25"), "24:00");
        check("desde: Fev/26", find("Fev/26"), "12:00");
        check("desde: Jan/26 (vazio)", find("Jan/26"), "0:00");
        check("desde: Mar/26 (vazio)", find("Mar/26"), "0:00");

        checkTrue("desde: total ON = 36:00",
            elements["grandTotal"].innerHTML.indexOf(
                'Total: <span id="live-total-on">36:00</span>') === 0,
            elements["grandTotal"].innerHTML);
    });
}

// ============================================================
// Execução
// ============================================================
async function main() {
    await settle();              // carga inicial: rede_disponivel / últimos 3 dias

    groupFormat();
    groupWindows();
    groupIntervals();
    groupDays();
    groupMonths();
    groupLeapYear();
    groupRenderDay();
    groupTimer();
    groupLive();
    await groupSwitch();
    await groupSince();

    console.log("\n== (M) Destroy ==");
    const clearBefore = clearIntervalCount;
    if (typeof destroyCallback === "function") { destroyCallback(); }
    check("destroy: clearInterval", String(clearIntervalCount),
        String(clearBefore + 1));

    console.log("");
    console.log("Resumo: " + passed + " passaram, " + failed + " falharam.");
    process.exit(failed === 0 ? 0 : 1);
}

main();
