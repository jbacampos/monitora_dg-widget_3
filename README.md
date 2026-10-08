# Monitora_DG — Widget PERÍODOS ON

Projeto local **independente** dos widgets `ENERGIA DO SÍTIO` (widget_1) e
`HISTÓRICO / SEQUÊNCIA DE ESTADOS` (widget_2), com a **mesma identidade
visual** (fundo `#292c32`, título no estilo de "HISTÓRICO DE TRANSIÇÕES",
LEDs `.st-dot`).

## Especificação

Para **um** dos quatro estados, mostra todos os **períodos em que o estado
permaneceu ON** dentro de um período selecionado, com **totalização por dia**
(períodos curtos) ou **por mês** (Este ano / Ano passado / Desde o início) e
**total geral com percentual ON**.

1. Estados (exatamente estes quatro, com as cores já adotadas):
   - `rede_disponivel` → `#21c55d` (verde)
   - `alimentacao_rede` → `#3182f6` (azul)
   - `alimentacao_offgrid` → `#eab308` (amarelo)
   - `alimentacao_gerador` → `#ef4444` (vermelho)
   - OFF → `#686B70`
   Sem emojis; indicadores são círculos CSS (`.st-dot`), iguais aos do widget 2.
2. Cabeçalho: quatro indicadores **clicáveis**. O selecionado fica normal; os
   outros três ficam esmaecidos. Um único widget (não quatro).
3. Seletor de período (valor inicial **Últimos 3 dias**): Hoje, Ontem, Últimos
   3 dias, Últimos 7 dias, Esta semana, Semana passada, Este mês, Mês passado,
   Este ano, Ano passado, Desde o início.
4. Intervalos:
   - Hoje: 00:00 de hoje → agora.
   - Ontem: 00:00 → 24:00 de ontem.
   - Últimos 3 dias: 00:00 de anteontem → agora.
   - Últimos 7 dias: 00:00 de seis dias atrás → agora.
   - Esta semana: início da semana local → agora.
   - Semana passada: semana completa anterior.
   - Este mês: primeiro dia do mês → agora.
   - Mês passado: mês completo anterior.
   - Este ano: 01/01 → agora.
   - Ano passado: ano completo anterior.
   - Desde o início: da **primeira informação histórica disponível** → agora.
5. Reconstrução dos períodos ON: ON inicia o período, OFF encerra; se já estava
   ON no início da janela, o período começa no início da janela; se está ON
   agora, termina em "agora". Um período que cruza a meia-noite é **dividido
   entre os dias**.
6. Tabela (períodos curtos = Hoje…Mês passado): agrupada por **dia**, com a
   data apenas na **primeira linha** do dia, linhas de período em ordem
   decrescente de horário, **total do dia** separado visualmente.
7. Tabela (Este ano / Ano passado / Desde o início): **uma linha por mês**.
   Mês sem nenhum período ON aparece como `0:00`.
8. Total geral: `Total: HH:MM / HH:MM = XX,X%` (o denominador é a **duração
   real** da janela — não se assume 24h × dias).
9. Atualização em tempo real por **timer local** (1 s), **sem** nova consulta
   ao ThingsBoard; o timer é destruído no `registerDestroyCallback`.
10. Formatos de duração: menos de 1 hora → `37m`; senão `H:MM` (acumulado,
    ex.: `8:33`, `62:42`, `142:37`). Nunca converte o total em dias.
    Horários dos períodos: `HH:MM`; fim na meia-noite → `24:00`; fim em
    andamento → `agora`.

## Modo Power on / reinícios (quinto indicador)

Além dos quatro estados, o cabeçalho tem um **quinto indicador** (símbolo
Power em SVG inline, círculo vermelho, sem emoji) que alterna o widget para o
modo **Power on**. Nesse modo a tabela lista o **histórico de reinícios**
(fonte: telemetria `reboot_reason`; o timestamp do ponto é o instante do
reboot), com as colunas **DATA | HORA | MOTIVO**, do mais recente para o mais
antigo, com a data apenas na primeira linha de cada dia e a hora em `HH:mm`.

- Não há períodos ON, totalização diária, total geral nem percentual neste modo.
- O seletor de período é o mesmo. Para as janelas curtas (Hoje…Mês passado) os
  reinícios são agrupados por dia; para Este ano / Ano passado / Desde o início
  cada reinício aparece individualmente (sem agrupar por mês).
- Sem polling de 1 s: novos `reboot_reason` chegam pela subscription já
  existente e a lista é redesenhada (sem novo request).
- Clicar em qualquer um dos quatro estados volta aos modos normais.

Códigos de `reboot_reason` (estáveis, definidos pelo firmware) → descrição.
Os textos são **os mesmos do programa Monitora_DG**
(`include/types.h` → `rebootReasonDescription()`), a única fonte da descrição do
motivo — assim o `MOTIVO` exibido aqui é idêntico ao da notificação de boot no
Telegram e ao da linha `BOOT DIAG` do Serial:

| código | descrição |
|---|---|
| 1 | Energização |
| 2 | Watchdog de hardware |
| 3 | Exceção de software |
| 4 | Watchdog de software |
| 5 | Reinício (/reboot) |
| 6 | Retorno de deep sleep |
| 7 | Reset externo |
| 8 | Desconhecido |
| 9 | Atualização (/ota) |

Um código desconhecido aparece como `Desconhecido` (o registro nunca é
descartado).

## Arquivos

- `index.html` — título, indicadores de estado, seletor de período, tabela e total geral.
- `style.css` — identidade visual dos widgets 1/2 + tabela e responsividade.
- `script.js` — janelas de período, reconstrução dos períodos ON, totalizações
  (dia/mês), total geral, subscription ao vivo e timer local.
- `preview.html` — ambiente local de teste (dados simulados); **não** é o widget publicado.
- `_test_periods.node.js` — harness de teste (não faz parte do widget).
- `.clinerules`, `.gitignore` — regras de trabalho e arquivos ignorados.

## Fonte dos dados

Histórico **real** via `ctx.http.get` (mesmo mecanismo do widget 2):

```
GET /api/plugins/telemetry/DEVICE/7e62cc00-c0df-11f1-8ef7-dd61fc2d324e
    /values/timeseries?keys=<estado>&startTs=..&endTs=..&limit=4000&orderBy=DESC
```

- Consulta **apenas a chave do estado selecionado**, **sem agregação**, para não
  eliminar mudanças intermediárias (usa os valores históricos/transições reais).
- **Paginação**: enquanto a página vier cheia (`= limit`), continua para trás
  (`endTs = ts mais antigo - 1`) até a página vir incompleta ou atingir
  `MAX_PAGES`. Necessário para janelas longas (Este ano / Ano passado / Desde o
  início).
- Para saber se o estado já estava ON no início da janela, é feita uma consulta
  pontual do **último ponto com `ts <= início`** (`limit=1&orderBy=DESC`).
- Não usa o widget "SEQUÊNCIA DE ESTADOS" como fonte; não depende do texto
  renderizado pelo widget 2.

## Atualização ao vivo

A subscription (`type: "latest"`, mesma do widget 2) escuta os quatro estados.
Quando a chave selecionada muda de valor, a transição é acrescentada aos pontos
e a tabela é redesenhada — **sem** nova consulta de histórico. O período em
andamento, o total do dia/mês, o total geral, a duração da janela e o
percentual são atualizados localmente a cada 1 s. Ao trocar de estado ou de
período há uma nova consulta ao histórico.

## Testes

```
# PowerShell (TZ=UTC garante resultado determinístico)
cd widget_3
$env:TZ='UTC'; node _test_periods.node.js
```

Cobertura (100 verificações): período ON simples; múltiplos no mesmo dia;
período cruzando a meia-noite; estado ON no início da janela; estado ON no fim;
estado OFF durante toda a janela; janela começando/terminando no meio de um
período; totalização diária; totalização mensal (meses vazios); percentual;
ano bissexto; "Hoje" parcial; "Desde o início"; render do modo dia e do modo
mês; timer único (1 s, sem novo request, destruído no destroy).

Sintaxe: `node --check script.js`.

## Decisões onde a especificação era ambígua (premissas)

- **Timezone**: usa o timezone **local** do navegador (igual aos widgets 1 e 2);
  nenhuma regra nova de timezone.
- **Início da semana** (`Esta semana` / `Semana passada`): **domingo**
  (constante `WEEK_START = 0`), coerente com os widgets existentes. Ajustável
  em uma linha.
- **Data na tabela**: `dd/mm` (ex.: `07/10`), como no exemplo do enunciado.
- **Rótulo de mês**: `Mmm/AA` capitalizado (ex.: `Out/26`).
- **Durações**: regra única da seção 12 (`37m` / `H:MM`), aplicada a períodos,
  totais de dia e total geral. Exceção exigida pela seção 11: **mês vazio =
  `0:00`**.
- **Fim exatamente à meia-noite**: exibido como `24:00`.
- **Ordem**: dias do mais recente para o mais antigo; dentro do dia, períodos do
  mais recente para o mais antigo; meses do mais recente para o mais antigo.
- **Mês-limite**: como a janela é `[início, fim)`, quando o fim cai exatamente no
  início de um mês (ex.: fim de "Ano passado"), esse mês **não** é incluído.

## Limitações da API/histórico do ThingsBoard

- A API `values/timeseries` retorna pontos por página (`limit`); janelas longas
  dependem de várias requisições (paginação). Há um teto de segurança
  (`MAX_PAGES = 60` × `PAGE_LIMIT = 4000`).
- Se o dispositivo publicar os estados com **deduplicação** habilitada no
  Device Profile, transições iguais consecutivas podem não estar no histórico;
  o widget trabalha com o que a API devolve.
- Períodos ON iniciados **antes** da primeira informação disponível (caso
  "Desde o início") começam na primeira amostra, pois não há dado anterior.

## Preview local

Abra `preview.html` em um navegador servido por um servidor local (o preview usa
`fetch('index.html')`), por exemplo `python -m http.server` na pasta
`widget_3`, e acesse `http://localhost:8000/preview.html`. O preview simula
`container`, `ctx`, a subscription e os dados do device; os botões disparam
transições ON/OFF ao vivo do estado `rede_disponivel`.

## Regra de trabalho

Alterações pequenas, controladas e verificáveis; preservar o comportamento
existente; testar no `preview.html` antes de publicar no ThingsBoard. Não foram
alterados os widgets 1 e 2, o firmware, a lógica do Monitora_DG nem o dashboard.
