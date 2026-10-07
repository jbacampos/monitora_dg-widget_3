// ============================================================
// WIDGET MONITORA_DG — PERÍODOS ON
// ------------------------------------------------------------
// Para o estado selecionado, reconstrói os intervalos em que o
// estado permaneceu ON dentro de uma janela escolhida, totaliza
// por dia (períodos curtos) ou por mês (Este ano / Ano passado /
// Desde o início) e exibe o total geral com percentual ON.
//
// Reutiliza o padrão dos widgets 1 e 2: mesmas cores/LEDs, leitura
// do histórico via ctx.http.get (values/timeseries), subscription
// ao vivo e timer local (sem nova consulta a cada segundo).
// ============================================================

const DEVICE_MONITORA_DG =
    "7e62cc00-c0df-11f1-8ef7-dd61fc2d324e";

// Estados e a cor do LED de cada um (mesma identidade dos widgets
// anteriores). A ordem define a ordem dos indicadores clicáveis.
const STATE_KEYS = [
    { key: "rede_disponivel",     on: "st-green"  },
    { key: "alimentacao_rede",    on: "st-blue"   },
    { key: "alimentacao_offgrid", on: "st-yellow" },
    { key: "alimentacao_gerador", on: "st-red"    }
];

// Primeiro dia da semana local (0 = domingo). Usado por "Esta semana"
// e "Semana passada".
const WEEK_START = 0;

// Paginação da consulta de histórico: cada página pede até PAGE_LIMIT
// pontos; se a página vier cheia, continua para trás até MAX_PAGES.
const PAGE_LIMIT = 4000;
const MAX_PAGES = 60;

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez"];

// Estado de execução do widget.
let selectedIndex = 0;
let selectedPeriod = "ultimos3dias";

// Último modelo renderizado (base para a atualização viva local).
let current = null;

// Timer único que atualiza o período em andamento sem novo request.
let liveTimer = null;

// ============================================================
// FORMATAÇÃO
// ============================================================

function pad2(n) {
    return String(n).padStart(2, "0");
}

// Duração no formato do widget: menos de 1 hora -> "37m";
// demais -> "H:MM" (acumulado, ex.: "8:33", "62:42", "142:37").
// Nunca converte o total em dias.
function formatDuration(ms) {
    const totalMin = Math.floor(Math.max(0, ms) / 60000);

    if (totalMin < 60) {
        return totalMin + "m";
    }

    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;

    return hours + ":" + pad2(minutes);
}

// Duração no formato do widget 2 — HISTÓRICO DE TRANSIÇÕES
// (24s / 16m 38s / 1h 6m 22s / 4h 59m 50s), porém sem o sufixo "0s"
// quando o valor cai em minuto cheio (13:48 -> "13h 48m", 0:27 -> "27m").
// Usada nas linhas dos períodos individuais E nas totalizações diárias.
// O total geral no rodapé e as totalizações mensais continuam usando
// formatDuration/formatMonthTotal (formato acumulado "H:MM").
function formatWidget2Duration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    let out = "";

    if (days > 0) {
        out += days + "d ";
    }

    if (days > 0 || hours > 0) {
        out += hours + "h ";
    }

    if (days > 0 || hours > 0 || minutes > 0) {
        out += minutes + "m ";
    }

    // Segundos aparecem apenas quando existem (regra do widget 2 para o
    // caso com segundos); em minuto cheio o sufixo "0s" é omitido.
    if (seconds > 0 || out === "") {
        out += seconds + "s";
    }

    return out.replace(/\s+$/, "");
}

// Horário HH:MM (24h) a partir de um timestamp local.
function formatClockMin(ts) {
    const d = new Date(ts);

    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Data dd/mm (aparece só na primeira linha do dia).
function formatDayLabel(ts) {
    const d = new Date(ts);

    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1);
}

// Rótulo de mês "Out/26".
function formatMonthLabel(ts) {
    const d = new Date(ts);
    const m = MONTHS[d.getMonth()];

    return m.charAt(0).toUpperCase() + m.slice(1) +
        "/" + String(d.getFullYear()).slice(-2);
}

// Intervalo do período. O fim em andamento aparece como "agora";
// um fim que coincide com a meia-noite local aparece como "24:00".
function formatRange(startTs, endTs, isOngoing) {
    const start = formatClockMin(startTs);

    if (isOngoing) {
        return start + " - agora";
    }

    const d = new Date(endTs);
    const isMidnight =
        d.getHours() === 0 && d.getMinutes() === 0 && endTs > startTs;

    return start + " - " + (isMidnight ? "24:00" : formatClockMin(endTs));
}

// Percentual ON (vírgula decimal, 1 casa), ex.: "87,1%".
function formatPercent(onMs, totalMs) {
    if (!(totalMs > 0)) {
        return "0,0%";
    }

    const pct = (onMs / totalMs) * 100;

    return pct.toFixed(1).replace(".", ",") + "%";
}

function isOn(value) {
    return Number(value) === 1;
}

// Totalização mensal: um mês sem nenhum período ON aparece como
// "0:00" (e não "0m"); os demais seguem a regra de duração.
function formatMonthTotal(ms) {
    return ms === 0 ? "0:00" : formatDuration(ms);
}

// ============================================================
// LIMITES DE TEMPO (timezone LOCAL, igual aos widgets existentes)
// ============================================================

function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function startOfWeek(ts) {
    const d = new Date(startOfDay(ts));
    const diff = (d.getDay() - WEEK_START + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d.getTime();
}

function startOfMonth(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d.getTime();
}

function startOfYear(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    d.setMonth(0, 1);
    return d.getTime();
}

function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
}

function addMonths(ts, n) {
    const d = new Date(ts);
    d.setMonth(d.getMonth() + n);
    return d.getTime();
}

function addYears(ts, n) {
    const d = new Date(ts);
    d.setFullYear(d.getFullYear() + n);
    return d.getTime();
}

// Janela analisada para cada opção do seletor.
// start/end em ms locais; liveEnd indica que o fim é "agora";
// mode "day" (tabela por dia) ou "month" (tabela por mês).
function computeWindow(periodId, now) {
    switch (periodId) {
    case "hoje":
        return { start: startOfDay(now), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    case "ontem":
        return { start: addDays(startOfDay(now), -1), end: startOfDay(now), liveEnd: false, desdeInicio: false, mode: "day" };
    case "ultimos3dias":
        return { start: addDays(startOfDay(now), -2), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    case "ultimos7dias":
        return { start: addDays(startOfDay(now), -6), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    case "estasemana":
        return { start: startOfWeek(now), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    case "semanapassada":
        return { start: addDays(startOfWeek(now), -7), end: startOfWeek(now), liveEnd: false, desdeInicio: false, mode: "day" };
    case "estemes":
        return { start: startOfMonth(now), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    case "mespassado":
        return { start: addMonths(startOfMonth(now), -1), end: startOfMonth(now), liveEnd: false, desdeInicio: false, mode: "day" };
    case "esteano":
        return { start: startOfYear(now), end: now, liveEnd: true, desdeInicio: false, mode: "month" };
    case "anopassado":
        return { start: addYears(startOfYear(now), -1), end: startOfYear(now), liveEnd: false, desdeInicio: false, mode: "month" };
    case "desdeoinicio":
        return { start: null, end: now, liveEnd: true, desdeInicio: true, mode: "month" };
    default:
        return { start: addDays(startOfDay(now), -2), end: now, liveEnd: true, desdeInicio: false, mode: "day" };
    }
}

// ============================================================
// RECONSTRUÇÃO DOS PERÍODOS ON
// ============================================================

// Ordena crescente e remove timestamps repetidos (fica o último).
function dedupeSortAsc(points) {
    const sorted = points.slice().sort(function (a, b) {
        return a.ts - b.ts;
    });
    const out = [];

    sorted.forEach(function (p) {
        if (out.length && out[out.length - 1].ts === p.ts) {
            out[out.length - 1] = p;
        } else {
            out.push(p);
        }
    });

    return out;
}

function sumDurations(intervals) {
    let total = 0;

    intervals.forEach(function (iv) {
        total += Math.max(0, iv[1] - iv[0]);
    });

    return total;
}

// A partir dos pontos (crescentes) do estado selecionado, reconstrói
// os intervalos [início, fim] em que o estado permaneceu ON dentro de
// [winStart, winEnd].
//  - estado ON no início da janela -> período começa em winStart;
//  - estado ON no fim da janela   -> período termina em winEnd.
// Retorna ainda onAtEnd (se o estado está ON no fim da janela).
function buildOnIntervals(points, winStart, winEnd) {
    const intervals = [];
    let curStart = null;
    let stateAtStart = false;
    let i;

    for (i = 0; i < points.length; i++) {
        if (points[i].ts <= winStart) {
            stateAtStart = isOn(points[i].value);
        } else {
            break;
        }
    }

    if (stateAtStart) {
        curStart = winStart;
    }

    for (i = 0; i < points.length; i++) {
        const p = points[i];

        if (p.ts <= winStart) {
            continue;
        }

        if (p.ts > winEnd) {
            break;
        }

        if (isOn(p.value)) {
            if (curStart === null) {
                curStart = p.ts;
            }
        } else if (curStart !== null) {
            intervals.push([curStart, p.ts]);
            curStart = null;
        }
    }

    if (curStart !== null) {
        intervals.push([curStart, winEnd]);
    }

    return { intervals: intervals, onAtEnd: curStart !== null };
}

// Divide intervalos que atravessam a meia-noite. Retorna os dias em
// ordem decrescente; dentro de cada dia, os segmentos em ordem
// decrescente. Cada dia traz sua própria soma (totalMs).
function splitByDay(intervals) {
    const map = new Map();

    function add(dayStart, s, e) {
        if (!map.has(dayStart)) {
            map.set(dayStart, []);
        }
        map.get(dayStart).push([s, e]);
    }

    intervals.forEach(function (iv) {
        const s = iv[0];
        const e = iv[1];

        if (e <= s) {
            add(startOfDay(s), s, s);
            return;
        }

        let cur = s;

        while (cur < e) {
            const dayStart = startOfDay(cur);
            const next = addDays(dayStart, 1);
            const segEnd = Math.min(e, next);

            add(dayStart, cur, segEnd);
            cur = segEnd;
        }
    });

    const days = Array.from(map.keys()).sort(function (a, b) {
        return b - a;
    });

    return days.map(function (dayStart) {
        const segments = map.get(dayStart).slice().sort(function (a, b) {
            return b[0] - a[0];
        });
        let totalMs = 0;

        segments.forEach(function (seg) {
            totalMs += Math.max(0, seg[1] - seg[0]);
        });

        return { dayStart: dayStart, segments: segments, totalMs: totalMs };
    });
}

// Totaliza por mês. Retorna todos os meses do intervalo (do mais
// recente ao mais antigo), inclusive meses sem nenhum período ON
// (totalMs = 0).
function buildMonthTotals(intervals, winStart, winEnd) {
    const map = new Map();

    function add(monthStart, ms) {
        map.set(monthStart, (map.get(monthStart) || 0) + ms);
    }

    intervals.forEach(function (iv) {
        const s = iv[0];
        const e = iv[1];

        if (e <= s) {
            const ms = startOfMonth(s);
            if (!map.has(ms)) {
                add(ms, 0);
            }
            return;
        }

        let cur = s;

        while (cur < e) {
            const monthStart = startOfMonth(cur);
            const next = addMonths(monthStart, 1);
            const segEnd = Math.min(e, next);

            add(monthStart, segEnd - cur);
            cur = segEnd;
        }
    });

    const months = [];
    const first = startOfMonth(winStart);
    // O último mês é o último mês ABRANGIDO pela janela. Quando winEnd
    // cai exatamente no início de um mês (ex.: fim de "ano passado"),
    // esse mês não faz parte da janela — usa-se winEnd - 1.
    let m = startOfMonth(winEnd - 1);

    while (m >= first) {
        months.push({ monthStart: m, totalMs: map.get(m) || 0 });
        m = addMonths(m, -1);
    }

    return months;
}

// ============================================================
// FONTE DOS DADOS
// ------------------------------------------------------------
// Histórico real via /values/timeseries (mesmo mecanismo do widget
// 2), porém consultando apenas a chave do estado selecionado e sem
// agregação, para não eliminar mudanças intermediárias.
// ============================================================

function telemetryUrl(key, startTs, endTs, limit) {
    return "/api/plugins/telemetry/DEVICE/" + DEVICE_MONITORA_DG +
        "/values/timeseries" +
        "?keys=" + encodeURIComponent(key) +
        "&startTs=" + startTs +
        "&endTs=" + endTs +
        "&limit=" + limit +
        "&orderBy=DESC";
}

function httpGet(url) {
    return new Promise(function (resolve, reject) {
        ctx.http.get(url).subscribe(
            function (response) { resolve(response || {}); },
            function (error) { reject(error); }
        );
    });
}

// Busca todos os pontos da chave em [startTs, endTs], paginando para
// trás enquanto as páginas vierem cheias. Filtra por intervalo no
// cliente (compatível com o simulador do preview) e devolve crescente.
function fetchSeries(key, startTs, endTs) {
    const collected = [];
    let end = endTs;
    let page = 0;

    function nextPage() {
        if (page >= MAX_PAGES) {
            return Promise.resolve();
        }

        return httpGet(telemetryUrl(key, startTs, end, PAGE_LIMIT))
            .then(function (response) {
                const arr = (response && response[key]) || [];

                if (!arr.length) {
                    return;
                }

                arr.forEach(function (p) {
                    const ts = Number(p.ts);

                    if (Number.isFinite(ts) && ts >= startTs && ts <= end) {
                        collected.push({ ts: ts, value: p.value });
                    }
                });

                page++;

                if (arr.length < PAGE_LIMIT) {
                    return;
                }

                const oldest = Number(arr[arr.length - 1].ts);

                if (!Number.isFinite(oldest) || oldest <= startTs) {
                    return;
                }

                end = oldest - 1;
                return nextPage();
            });
    }

    return nextPage().then(function () {
        return dedupeSortAsc(collected);
    });
}

// Ponto mais recente da chave com ts <= atéTs (estado no início da
// janela). Devolve { ts, value } ou null.
function fetchLastBefore(key, untilTs) {
    return httpGet(telemetryUrl(key, 0, untilTs, 1))
        .then(function (response) {
            const arr = (response && response[key]) || [];
            let best = null;

            arr.forEach(function (p) {
                const ts = Number(p.ts);

                if (
                    Number.isFinite(ts) &&
                    ts <= untilTs &&
                    (best === null || ts > best.ts)
                ) {
                    best = { ts: ts, value: p.value };
                }
            });

            return best;
        });
}

function renderMessage(text) {
    const periodsEl = container.querySelector("#periods");
    const totalEl = container.querySelector("#grandTotal");

    if (periodsEl) {
        periodsEl.innerHTML =
            '<div class="periods-empty">' + text + "</div>";
    }

    if (totalEl) {
        totalEl.innerHTML = "";
    }
}

// ============================================================
// RENDERIZAÇÃO
// ============================================================

// Reconstrói e desenha a tabela + total geral a partir de `current`.
// Guarda em `current` as bases para a atualização viva local.
function renderCurrent() {
    const periodsEl = container.querySelector("#periods");
    const totalEl = container.querySelector("#grandTotal");

    if (!periodsEl || !current) {
        return;
    }

    const winStart = current.winStart;
    const winEnd = current.liveEnd ? Date.now() : current.winEnd;

    const res = buildOnIntervals(current.points, winStart, winEnd);
    const intervals = res.intervals;
    const ongoing =
        (current.liveEnd && res.onAtEnd && intervals.length)
            ? intervals[intervals.length - 1]
            : null;

    const totalOnMs = sumDurations(intervals);
    const totalDurMs = Math.max(0, winEnd - winStart);

    // Reinicia as bases do modo vivo.
    current.os = ongoing ? ongoing[0] : null;
    current.segStart = null;
    current.monthGrowStart = null;
    current.baselineOnMs = totalOnMs;
    current.dayBaselineMs = 0;
    current.monthBaselineMs = 0;

    let bodyHtml = "";

    if (current.mode === "day") {
        const days = splitByDay(intervals);

        if (!days.length) {
            bodyHtml =
                '<div class="periods-empty">' +
                "Nenhum período ON no intervalo selecionado." +
                "</div>";
        }

        days.forEach(function (day) {
            bodyHtml += '<div class="p-group">';

            day.segments.forEach(function (seg, si) {
                const isOngoing = !!ongoing && seg[1] === winEnd;

                bodyHtml +=
                    '<div class="p-row">' +
                    '<span class="p-date">' +
                    (si === 0 ? formatDayLabel(day.dayStart) : "") +
                    "</span>" +
                    '<span class="p-range">' +
                    formatRange(seg[0], seg[1], isOngoing) +
                    "</span>" +
                    '<span class="p-dur"' +
                    (isOngoing ? ' id="live-seg-dur"' : "") +
                    ">" + formatWidget2Duration(seg[1] - seg[0]) + "</span>" +
                    "</div>";
            });

            const isOngoingDay =
                !!ongoing && day.segments.some(function (s) {
                    return s[1] === winEnd;
                });

            bodyHtml +=
                '<div class="p-row p-sum">' +
                '<span class="p-date"></span>' +
                '<span class="p-range"></span>' +
                '<span class="p-val"' +
                (isOngoingDay ? ' id="live-day-tot"' : "") +
                ">" + formatWidget2Duration(day.totalMs) + "</span>" +
                "</div>";

            bodyHtml += "</div>";
        });

        if (ongoing) {
            const activeDayStart = startOfDay(winEnd);
            const day = days.find(function (d) {
                return d.dayStart === activeDayStart;
            });

            if (day) {
                const segStart = Math.max(ongoing[0], activeDayStart);
                current.segStart = segStart;
                current.baselineOnMs = totalOnMs - (winEnd - ongoing[0]);
                current.dayBaselineMs = day.totalMs - (winEnd - segStart);
            }
        }
    } else {
        const months = buildMonthTotals(intervals, winStart, winEnd);

        if (!months.length) {
            bodyHtml =
                '<div class="periods-empty">' +
                "Nenhum período ON no intervalo selecionado." +
                "</div>";
        }

        months.forEach(function (m) {
            const isOngoingMonth =
                !!ongoing && m.monthStart === startOfMonth(winEnd);

            bodyHtml +=
                '<div class="m-row">' +
                '<span class="m-label">' +
                formatMonthLabel(m.monthStart) +
                "</span>" +
                '<span class="m-val"' +
                (isOngoingMonth ? ' id="live-month-tot"' : "") +
                ">" + formatMonthTotal(m.totalMs) + "</span>" +
                "</div>";
        });

        if (ongoing) {
            const activeMonthStart = startOfMonth(winEnd);
            const mo = months.find(function (m) {
                return m.monthStart === activeMonthStart;
            });

            if (mo) {
                const growStart = Math.max(ongoing[0], activeMonthStart);
                current.monthGrowStart = growStart;
                current.baselineOnMs = totalOnMs - (winEnd - ongoing[0]);
                current.monthBaselineMs = mo.totalMs - (winEnd - growStart);
            }
        }
    }

    periodsEl.innerHTML = bodyHtml;

    if (totalEl) {
        totalEl.innerHTML =
            "Total: " +
            '<span id="live-total-on">' + formatDuration(totalOnMs) + "</span>" +
            " / " +
            '<span id="live-total-dur">' + formatDuration(totalDurMs) + "</span>" +
            " = " +
            '<span id="live-pct">' + formatPercent(totalOnMs, totalDurMs) +
            "</span>";
    }

    if (current.liveEnd) {
        startTimer();
    } else {
        stopTimer();
    }
}

// ============================================================
// ATUALIZAÇÃO VIVA (sem novo request)
// ------------------------------------------------------------
// Um único setInterval recalcula localmente o período em andamento,
// o total geral, a duração da janela e o percentual a cada 1s.
// ============================================================

function tick() {
    if (!current) {
        return;
    }

    const now = Date.now();
    const totalDur = now - current.winStart;
    let totalOn = current.baselineOnMs;

    if (current.os !== null) {
        totalOn = current.baselineOnMs + (now - current.os);
    }

    if (current.segStart !== null) {
        const segMs = now - current.segStart;
        const segEl = container.querySelector("#live-seg-dur");
        const dayEl = container.querySelector("#live-day-tot");

        if (segEl) {
            segEl.textContent = formatWidget2Duration(segMs);
        }

        if (dayEl) {
            dayEl.textContent =
                formatWidget2Duration(current.dayBaselineMs + segMs);
        }
    }

    if (current.monthGrowStart !== null) {
        const monEl = container.querySelector("#live-month-tot");

        if (monEl) {
            monEl.textContent = formatDuration(
                current.monthBaselineMs + (now - current.monthGrowStart)
            );
        }
    }

    const onEl = container.querySelector("#live-total-on");
    const durEl = container.querySelector("#live-total-dur");
    const pctEl = container.querySelector("#live-pct");

    if (onEl) {
        onEl.textContent = formatDuration(totalOn);
    }

    if (durEl) {
        durEl.textContent = formatDuration(totalDur);
    }

    if (pctEl) {
        pctEl.textContent = formatPercent(totalOn, totalDur);
    }
}

function startTimer() {
    if (liveTimer !== null) {
        return;
    }

    liveTimer = setInterval(tick, 1000);
}

function stopTimer() {
    if (liveTimer !== null) {
        clearInterval(liveTimer);
        liveTimer = null;
    }
}

// ============================================================
// SUBSCRIPTION AO VIVO
// ------------------------------------------------------------
// Escuta os quatro estados (type "latest"). Quando a chave do
// estado selecionado muda de valor, acrescenta a transição aos
// pontos e redesenha — sem nova consulta de histórico.
// ============================================================

function findLiveItem(data, key) {
    return data.find(function (d) {
        return d.dataKey &&
            d.dataKey.name === key &&
            d.dataKey.type === "timeseries" &&
            d.datasource &&
            d.datasource.entityFilter &&
            d.datasource.entityFilter.singleEntity &&
            d.datasource.entityFilter.singleEntity.id === DEVICE_MONITORA_DG;
    });
}

function handleLive(data) {
    if (!current || !current.liveEnd) {
        return;
    }

    const item = findLiveItem(data || [], current.key);

    if (!item || !item.data || !item.data.length) {
        return;
    }

    const point = item.data[item.data.length - 1];
    const ts = Number(point[0]);

    if (!Number.isFinite(ts)) {
        return;
    }

    const last = current.points.length
        ? current.points[current.points.length - 1]
        : null;

    // Timestamp já conhecido (ou mais antigo): ignora.
    if (last && ts <= last.ts) {
        return;
    }

    // Sem mudança de valor: não é transição.
    if (last && isOn(last.value) === isOn(point[1])) {
        return;
    }

    current.points.push({ ts: ts, value: point[1] });
    renderCurrent();
}

function startLiveSubscription() {
    const subscriptionOptions = {
        type: "latest",

        datasources: [{
            type: "entity",

            entityFilter: {
                type: "singleEntity",
                singleEntity: {
                    entityType: "DEVICE",
                    id: DEVICE_MONITORA_DG
                }
            },

            dataKeys: STATE_KEYS.map(function (state) {
                return { type: "timeseries", name: state.key, settings: {} };
            })
        }],

        callbacks: {
            onDataUpdated: function (subscription) {
                handleLive(subscription.data || []);
            }
        }
    };

    ctx.subscriptionApi
        .createSubscription(subscriptionOptions, true)
        .subscribe(function (subscription) {
            ctx.defaultSubscription = subscription;
        });
}

// ============================================================
// CONTROLES (seleção de estado / período)
// ============================================================

function updatePickerVisual() {
    const picker = container.querySelector("#statePicker");

    if (!picker) {
        return;
    }

    const btns = picker.querySelectorAll(".state-btn");

    btns.forEach(function (btn, i) {
        if (i === selectedIndex) {
            btn.classList.add("active");
            btn.setAttribute("aria-selected", "true");
        } else {
            btn.classList.remove("active");
            btn.setAttribute("aria-selected", "false");
        }
    });
}

function selectState(index) {
    if (index < 0 || index >= STATE_KEYS.length) {
        return;
    }

    selectedIndex = index;
    updatePickerVisual();
    reload();
}

function setupControls() {
    const picker = container.querySelector("#statePicker");

    if (picker) {
        const btns = picker.querySelectorAll(".state-btn");

        btns.forEach(function (btn, i) {
            btn.addEventListener("click", function () {
                selectState(i);
            });
        });
    }

    const sel = container.querySelector("#periodSelect");

    if (sel) {
        selectedPeriod = sel.value || "ultimos3dias";
        sel.addEventListener("change", function () {
            selectedPeriod = sel.value;
            reload();
        });
    }

    updatePickerVisual();
}

// ============================================================
// CARGA DOS DADOS
// ============================================================

function beginRender(cfg) {
    current = {
        key: cfg.key,
        points: cfg.points,
        winStart: cfg.winStart,
        winEnd: cfg.winEnd,
        liveEnd: !!cfg.liveEnd,
        mode: cfg.mode,
        os: null,
        segStart: null,
        monthGrowStart: null,
        baselineOnMs: 0,
        dayBaselineMs: 0,
        monthBaselineMs: 0
    };

    renderCurrent();
}

function reload() {
    stopTimer();
    renderMessage("Carregando...");

    const now = Date.now();
    const spec = computeWindow(selectedPeriod, now);
    const key = STATE_KEYS[selectedIndex].key;

    function onError(error) {
        console.error("Monitora_DG períodos ON:", error);
        renderMessage("Não foi possível carregar o histórico.");
    }

    if (spec.desdeInicio) {
        fetchSeries(key, 0, spec.end)
            .then(function (points) {
                if (!points.length) {
                    renderMessage("Sem dados no período.");
                    return;
                }

                beginRender({
                    key: key,
                    points: points,
                    winStart: points[0].ts,
                    winEnd: spec.end,
                    liveEnd: spec.liveEnd,
                    mode: spec.mode
                });
            })
            .catch(onError);
        return;
    }

    Promise.all([
        fetchSeries(key, spec.start, spec.end),
        fetchLastBefore(key, spec.start)
    ]).then(function (results) {
        const points = results[0];
        const before = results[1];
        const all = points.slice();

        if (before) {
            all.push(before);
        }

        beginRender({
            key: key,
            points: dedupeSortAsc(all),
            winStart: spec.start,
            winEnd: spec.end,
            liveEnd: spec.liveEnd,
            mode: spec.mode
        });
    }).catch(onError);
}

// ============================================================
// LIMPEZA
// ============================================================

ctx.registerDestroyCallback(function () {
    stopTimer();
    current = null;
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

setupControls();
startLiveSubscription();
reload();
