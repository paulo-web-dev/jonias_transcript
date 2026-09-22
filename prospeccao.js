"use strict";

// Prospecção ativa — importação das planilhas de carteiras por setor
// (ATIVOS PARANÁ.xlsx / ATIVO SANTA CATARINA.xlsx: uma aba por setor do órgão).
// O jonIAs é o lugar OFICIAL desse controle: a carga precisa ter fidelidade
// total. Regras (decisões do usuário, 2026-09-09):
//   - colunas casadas por NOME normalizado com dicionário de sinônimos, nunca
//     por posição; toda aba/coluna que não casar é listada — nada some em silêncio;
//   - telefone: original preservado + dígitos puros (célula que o Excel virou
//     "data" é recuperada do XML bruto da aba — o exceljs perde o número);
//   - COR É INFORMAÇÃO: cor de cada linha e de cada célula extraída (tema+tint
//     resolvidos para RGB); o significado é dado pelo usuário em /prospeccao;
//   - tudo preservado: extras, ocultas, nome da aba (setor), UF do upload;
//   - chave natural (uf, aba, nº da linha): reimportar faz upsert; aba com
//     linha editada no jonIAs é recusada (o sistema virou a fonte).
// Nada de IA — só leitura determinística e SQL.

const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const db = require("./db.js");
const {
  normalizarNome, hashSha256, valorCelula, dataCelulaIso, novoRelatorio,
  registrarOcorrencia, registrarImportacaoErro, avisarSeReimportacao,
} = require("./importacao.js");
const { cruzarMunicipios, normalizarCidade, indiceMunicipios } = require("./territorio.js");
const { clausulaMunicipios, dentroDoEscopo } = require("./escopo.js");
const cdr = require("./cruzamento.js");

const UFS_ACEITAS = ["PR", "SC", "SP", "RS", "MS", "MG", "RJ", "ES", "GO", "MT", "DF", "BA"];
const MAX_LINHAS_CABECALHO = 5;
const EXEMPLOS_POR_COR = 5;

// ---------- Dicionário de colunas (sinônimos normalizados: sem acento, minúsculas) ----------

const CAMPOS = {
  consultor: ["consultor", "consultor(a)", "consultora", "colaboradora", "colaborador", "vendedor", "vendedora"],
  municipio: ["municipio", "municipios", "cidade", "cidades"],
  telefone: ["telefone", "telefones", "contato", "tel", "fone", "numero", "telefone fixo", "telefone 1", "telefone da prefeitura", "telefone prefeitura"],
  whatsapp: ["whatsapp", "whats", "celular", "whats novo", "whatsapp novo", "whats/responsavel", "celular/whats", "wpp"],
  responsavel: ["responsavel", "reponsavel", "responsavel(a)", "nome", "nome novo", "nome 2", "contato responsavel", "responsavel novo"],
  cargo: ["cargo", "funcao", "cargo/funcao"],
  email: ["e-mail", "email", "e-mails", "emails", "e-mails novos", "e-mail novo", "email novo", "e-mail 2"],
  data: ["data", "data contato", "data do contato", "ultimo contato", "data ultimo contato", "dt"],
  observacoes: ["obs", "observacao", "observacoes", "obs.", "observacao 1", "obs 1", "obs - 1", "obs i"],
  setor_planilha: ["setor", "secretaria", "departamento"],
  entidade: ["entidade", "orgao", "instituto", "autarquia", "autarquias"],
  situacao: ["situacao", "status"],
  curso: ["curso", "cursos", "c curso", "curso de interesse"],
  contato_inexistente: ["contato inexistente", "contatos inexistente", "contatos inexistentes", "tel inexistente", "telefone inexistente"],
  cadastro_crm: ["cadastro no crm?", "cadastro no crm", "crm", "cadastrado no crm"],
};
// Padrões para variações não listadas ("obs 2", "obs (agnes)", "e-mails novos"…)
const PADROES = [
  ["contato_inexistente", /inexist/],
  ["observacoes", /^obs(ervac(ao|oes))?\b/],
  ["email", /^e-?mails?\b(?!.*antig)/],
  ["whatsapp", /^whats/],
  ["telefone", /^tel(efone)?\b/],
  ["curso", /^c\s+curso$/],
];

// "Sim"/"Não" (e variações) → 1/0; qualquer outro texto → null (vai para extras)
function booleanoDeTexto(texto) {
  const n = normalizarRotulo(texto);
  if (["sim", "s", "yes", "x", "ok", "1", "true"].includes(n)) return 1;
  if (["nao", "n", "no", "0", "false"].includes(n)) return 0;
  return null;
}

const desmojibake = (t) => (/[ÃÂ][\x80-\xBF]/.test(t) ? Buffer.from(t, "latin1").toString("utf8") : t);
const normalizarRotulo = (t) =>
  normalizarNome(desmojibake(String(t ?? "")).replace(/­/g, "")).replace(/\s+/g, " ").trim();

function campoDoRotulo(rotuloNorm) {
  for (const [campo, sinonimos] of Object.entries(CAMPOS)) if (sinonimos.includes(rotuloNorm)) return campo;
  for (const [campo, re] of PADROES) if (re.test(rotuloNorm)) return campo;
  return null;
}

// Órgão derivado do nome da aba — heurística simples e explícita; corrigível depois
function orgaoDaAba(nome) {
  const n = normalizarRotulo(nome);
  if (/\b(cm|camara)\b/.test(n)) return "CM";
  if (/\b(pm|prefeitura)\b/.test(n)) return "PM";
  if (/autarquia|rpps|instituto/.test(n)) return "Autarquia";
  return null;
}

// ---------- Cores: ARGB, tema+tint, indexadas → RGB de 6 hex ----------

// Ordem dos índices de tema no OOXML (styles.xml theme="n"): 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4–9 accent1–6
const ORDEM_TEMA = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
// Paleta indexada padrão (só os índices que aparecem em planilhas comuns)
const PALETA_INDEXADA = {
  0: "000000", 1: "FFFFFF", 2: "FF0000", 3: "00FF00", 4: "0000FF", 5: "FFFF00", 6: "FF00FF", 7: "00FFFF",
  8: "000000", 9: "FFFFFF", 10: "FF0000", 11: "00FF00", 12: "0000FF", 13: "FFFF00", 14: "FF00FF", 15: "00FFFF",
  16: "800000", 17: "008000", 18: "000080", 19: "808000", 20: "800080", 21: "008080", 22: "C0C0C0", 23: "808080",
  40: "00CCFF", 41: "CCFFFF", 42: "CCFFCC", 43: "FFFF99", 44: "99CCFF", 45: "FF99CC", 46: "CC99FF", 47: "FFCC99",
  64: "000000", 65: "FFFFFF",
};

function paletaDoTema(workbook) {
  const xml = workbook._themes?.theme1 || "";
  const paleta = {};
  for (const [, nome, cor] of xml.matchAll(
    /<a:(dk1|lt1|dk2|lt2|accent\d)>\s*<a:(?:srgbClr|sysClr)[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/g
  )) paleta[nome] = cor.toUpperCase();
  return ORDEM_TEMA.map((n) => paleta[n] || null);
}

function hexParaRgb(hex) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function rgbParaHex(r, g, b) {
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}
// Tint do OOXML: aplicado na luminância HSL (tint < 0 escurece, > 0 clareia)
function aplicarTint(hex, tint) {
  if (!tint) return hex;
  const [r, g, b] = hexParaRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  if (s === 0) return rgbParaHex(l, l, l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const canal = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbParaHex(canal(h + 1 / 3), canal(h), canal(h - 1 / 3));
}

// cell.fill → { hex, origem } ou null (sem preenchimento sólido)
function corDoFill(fill, tema, avisos) {
  if (!fill || fill.type !== "pattern" || !fill.pattern || fill.pattern === "none") {
    if (fill && fill.type === "gradient" && fill.stops?.[0]?.color) {
      avisos.add("preenchimento em gradiente encontrado — usada a cor inicial");
      return corDoFill({ type: "pattern", pattern: "solid", fgColor: fill.stops[0].color }, tema, avisos);
    }
    return null;
  }
  const c = fill.fgColor;
  if (!c) return null;
  if (c.argb) return { hex: c.argb.slice(-6).toUpperCase(), origem: "argb" };
  if (c.theme !== undefined && c.theme !== null) {
    const base = tema[c.theme];
    if (!base) { avisos.add(`cor de tema ${c.theme} sem definição no arquivo`); return null; }
    const tint = Number(c.tint || 0);
    return { hex: aplicarTint(base, tint), origem: `tema ${c.theme}${tint ? ` tint ${tint.toFixed(2)}` : ""}` };
  }
  if (c.indexed !== undefined && c.indexed !== null) {
    const hex = PALETA_INDEXADA[c.indexed];
    if (!hex) { avisos.add(`cor indexada ${c.indexed} fora da paleta conhecida`); return null; }
    return { hex, origem: `indexada ${c.indexed}` };
  }
  return null;
}

// ---------- Valores brutos das abas (XML) — para telefone que virou "data" ----------

async function valoresBrutosPorAba(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const resultado = new Map(); // nome da aba → Map(ref → valor bruto numérico)
  if (!workbookXml || !relsXml) return resultado;
  const rels = Object.fromEntries(
    [...relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]])
  );
  const relsInvertido = Object.fromEntries(
    [...relsXml.matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)].map((m) => [m[2], m[1]])
  );
  const decodificar = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const nome = decodificar(attrs.match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = attrs.match(/\br:id="([^"]*)"/)?.[1];
    const alvo = rels[rid] ?? relsInvertido[rid];
    if (!nome || !alvo) continue;
    const caminho = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`;
    const xml = await zip.file(caminho)?.async("string");
    if (!xml) continue;
    const mapa = new Map();
    // Célula vazia é self-closing (<c r="A1" s="3"/>): a alternativa "/>" vem
    // primeiro para o regex não varrer até o próximo </c> (era O(n²): 71 s no PR).
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const attr = c[1];
      if (c[2] === undefined || /\bt="(s|str|inlineStr|b|e)"/.test(attr)) continue; // vazia/texto/booleano/erro
      const ref = attr.match(/\br="([A-Z]+\d+)"/)?.[1];
      const v = c[2].match(/<v>([^<]*)<\/v>/)?.[1];
      if (ref && v !== undefined) mapa.set(ref, v);
    }
    resultado.set(nome, mapa);
  }
  return resultado;
}

// ---------- Telefone ----------

// Devolve { original, digitos, valido } a partir da célula (e do valor bruto do XML quando for Date)
function lerTelefone(cell, brutos) {
  const v = cell.value;
  if (v === null || v === undefined) return { original: null, digitos: null, valido: null };
  let original;
  if (v instanceof Date || cell.type === ExcelJS.ValueType.Date) {
    const bruto = brutos?.get(cell.address);
    if (bruto !== undefined && /^[-+0-9.eE]+$/.test(bruto)) original = numeroParaTexto(Number(bruto));
    else if (v instanceof Date && !isNaN(v)) {
      original = numeroParaTexto(Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 86400000)); // serial de volta
    } else original = "<data inválida>";
  } else if (typeof v === "number") original = numeroParaTexto(v);
  else original = String(valorCelula(v) ?? "").trim();
  return normalizarTelefoneOriginal(original);
}

function numeroParaTexto(n) {
  return Number.isFinite(n) ? String(Math.round(n)) : String(n);
}

// "(43) 3000-0000" → "4330000000"; "55 44 9…" → sem o 55; "0xx…" → sem o 0.
// Célula com mais de um número ("(44) 3000-0000 / (44) 3000-0001", "… ou …"):
// o primeiro vira o telefone; os demais ficam em `outros` (vão para extras).
function normalizarTelefoneOriginal(original) {
  if (!original) return { original: null, digitos: null, valido: null, outros: [] };
  const partes = original.split(/\s*(?:\/|;|\|| e | ou |>|,)\s*/i).filter((p) => p.replace(/\D/g, "").length >= 8);
  const candidatos = partes.length > 1 ? partes : [original];
  const normalizar = (texto) => {
    let d = texto.replace(/\D/g, "");
    if (!d) return null;
    if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
    if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);
    return d;
  };
  const digitos = normalizar(candidatos[0]);
  if (!digitos) return { original, digitos: null, valido: 0, outros: [] };
  const valido = digitos.length === 10 || digitos.length === 11 ? 1 : 0;
  const outros = candidatos.slice(1).map(normalizar).filter(Boolean);
  return { original, digitos, valido, outros };
}

// ---------- Leitura de uma aba ----------

const textoDaCelula = (cell) => {
  const v = valorCelula(cell.value);
  if (v === null) return null;
  if (v instanceof Date) return isNaN(v) ? null : dataCelulaIso(v);
  return typeof v === "number" ? numeroParaTexto(v) : String(v);
};

function detectarCabecalho(ws) {
  for (let r = 1; r <= Math.min(MAX_LINHAS_CABECALHO, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const colunas = []; // { idx, rotulo, norm, campo }
    row.eachCell({ includeEmpty: false }, (cell, idx) => {
      const rotulo = textoDaCelula(cell);
      if (!rotulo) return;
      const norm = normalizarRotulo(rotulo);
      colunas.push({ idx, rotulo: String(rotulo).trim(), norm, campo: campoDoRotulo(norm) });
    });
    if (colunas.filter((c) => c.campo).length >= 2) return { linha: r, colunas };
  }
  return null;
}

// Resolve o mapeamento final: 1º de cada campo vence; repetidos → extras.
function mapearColunas(cabecalho) {
  const mapa = {}; // campo → coluna
  const extras = [];
  for (const c of cabecalho.colunas) {
    if (c.campo && !mapa[c.campo]) mapa[c.campo] = c;
    else extras.push(c);
  }
  return { mapa, extras };
}

// Colunas de rótulo genérico ("Coluna 1", "Column 32") são decididas pelo
// CONTEÚDO, nunca pela posição: em "PM TRIBUTAÇÃO" a Coluna 1 é o consultor,
// em "JURIDICO PM" (SC) é o município e a Coluna 2 é o telefone. Regra: ≥ 80 %
// dos valores não vazios (mínimo 5) precisam bater com município da UF, com
// padrão de telefone ou com nome de consultor cadastrado em `pessoas`; só
// preenche campo ainda vazio; fica registrado no relatório como inferência.
const RE_COLUNA_GENERICA = /^colu?m?na? \d+$/;
let nomesConsultoresCache = null;
function nomesConsultores() {
  if (nomesConsultoresCache) return nomesConsultoresCache;
  nomesConsultoresCache = new Set();
  for (const p of db.prepare("SELECT nome, wallet_nome, nomes_alternativos FROM pessoas").all()) {
    for (const n of [p.nome, p.wallet_nome, ...JSON.parse(p.nomes_alternativos || "[]")]) {
      if (n) nomesConsultoresCache.add(normalizarRotulo(n));
    }
  }
  return nomesConsultoresCache;
}

function inferirColunasGenericas(ws, cabecalho, mapa, extras, uf, avisosAba) {
  const { porNome } = indiceMunicipios();
  const consultores = nomesConsultores();
  const testes = [
    ["municipio", (v) => (porNome.get(normalizarCidade(v).nome) || []).some((m) => m.uf === uf)],
    ["telefone", (v) => /^[\d\s().+\-/]+$/.test(v) && v.replace(/\D/g, "").length >= 8],
    ["whatsapp", (v) => /^[\d\s().+\-/]+$/.test(v) && v.replace(/\D/g, "").length >= 8],
    ["consultor", (v) => consultores.has(normalizarRotulo(v)) || consultores.has(normalizarRotulo(v).split(" ")[0])],
  ];
  for (const c of [...extras]) {
    if (!RE_COLUNA_GENERICA.test(c.norm)) continue;
    const amostra = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r <= cabecalho.linha || amostra.length >= 80) return;
      const v = textoDaCelula(row.getCell(c.idx));
      if (v !== null && v !== "") amostra.push(v);
    });
    if (amostra.length < 5) continue;
    for (const [campo, teste] of testes) {
      if (mapa[campo]) continue;
      const acertos = amostra.filter(teste).length;
      if (acertos / amostra.length >= 0.8) {
        mapa[campo] = c;
        extras.splice(extras.indexOf(c), 1);
        avisosAba.add(`"${c.rotulo}" tratada como ${campo} pelo conteúdo (${acertos}/${amostra.length} valores batem)`);
        break;
      }
    }
  }
}

function lerAba(ws, uf, brutos, tema, contexto) {
  const avisosAba = new Set();
  const cabecalho = detectarCabecalho(ws);
  const resumo = {
    aba: ws.name, oculta: ws.state !== "visible", linhasLidas: 0, linhasVazias: 0, importadas: 0, ocultas: 0,
    colunas: {}, naoReconhecidas: [], telefones: { validos: 0, invalidos: 0, vazios: 0 },
    cores: {}, avisos: [], linhas: [],
  };
  if (!cabecalho) {
    resumo.motivo = "sem cabeçalho reconhecido nas 5 primeiras linhas";
    return resumo;
  }
  const { mapa, extras } = mapearColunas(cabecalho);
  inferirColunasGenericas(ws, cabecalho, mapa, extras, uf, avisosAba);
  resumo.linhaCabecalho = cabecalho.linha;
  for (const [campo, c] of Object.entries(mapa)) resumo.colunas[campo] = c.rotulo;
  resumo.naoReconhecidas = extras.map((c) => c.rotulo);
  for (const c of extras) {
    const chave = c.norm;
    const g = contexto.naoReconhecidas.get(chave) ?? contexto.naoReconhecidas.set(chave, { rotulo: c.rotulo, abas: new Set(), linhas: 0 }).get(chave);
    g.abas.add(ws.name);
  }
  const orgao = orgaoDaAba(ws.name);
  const idxMunicipio = mapa.municipio?.idx ?? null;
  const colunasTodas = [...cabecalho.colunas];

  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r <= cabecalho.linha) return;
    resumo.linhasLidas++;
    // valores por célula (só das colunas com cabeçalho)
    let temValor = false;
    const celulas = new Map();
    for (const c of colunasTodas) {
      const cell = row.getCell(c.idx);
      if (cell.type === ExcelJS.ValueType.Merge) continue;
      const texto = textoDaCelula(cell);
      const cor = corDoFill(cell.fill, tema, avisosAba);
      celulas.set(c.idx, { cell, texto, cor });
      if (texto !== null && texto !== "") temValor = true;
    }
    if (!temValor) { resumo.linhasVazias++; return; }

    // cor da linha = moda das cores das células (empate: coluna município)
    const contagemCores = new Map();
    for (const { cor } of celulas.values()) if (cor) contagemCores.set(cor.hex, (contagemCores.get(cor.hex) || 0) + 1);
    let corLinha = null;
    if (contagemCores.size) {
      const max = Math.max(...contagemCores.values());
      const empatadas = [...contagemCores].filter(([, n]) => n === max).map(([h]) => h);
      const corMunicipio = idxMunicipio && celulas.get(idxMunicipio)?.cor?.hex;
      corLinha = empatadas.length > 1 && empatadas.includes(corMunicipio) ? corMunicipio : empatadas[0];
    }
    const coresCelulas = {};
    for (const c of colunasTodas) {
      const cel = celulas.get(c.idx);
      if (cel?.cor && cel.cor.hex !== corLinha) coresCelulas[c.campo && mapa[c.campo] === c ? c.campo : c.rotulo] = cel.cor.hex;
    }
    for (const { cor } of celulas.values()) if (cor) contexto.cores.set(cor.hex, cor.origem);
    resumo.cores[corLinha ?? "(sem cor)"] = (resumo.cores[corLinha ?? "(sem cor)"] || 0) + 1;

    // campos mapeados
    const campo = (nome) => (mapa[nome] ? celulas.get(mapa[nome].idx) : null);
    const textoDe = (nome) => campo(nome)?.texto ?? null;
    const tel = mapa.telefone ? lerTelefone(campo("telefone").cell, brutos) : { original: null, digitos: null, valido: null };
    const whats = mapa.whatsapp ? lerTelefone(campo("whatsapp").cell, brutos) : { original: null, digitos: null, valido: null };
    if (tel.valido === 1) resumo.telefones.validos++;
    else if (tel.valido === 0) resumo.telefones.invalidos++;
    else resumo.telefones.vazios++;

    const extrasLinha = {};
    let data = null;
    if (mapa.data) {
      const cel = campo("data");
      const v = valorCelula(cel.cell.value);
      data = v === null ? null : dataCelulaIso(v);
      if (v !== null && !data) extrasLinha[`${mapa.data.rotulo} (texto)`] = String(v);
      if (data && data.length > 10) data = data.slice(0, 10);
    }
    for (const c of extras) {
      const cel = celulas.get(c.idx);
      if (cel && cel.texto !== null && cel.texto !== "") {
        const chaveExtra = extrasLinha[c.rotulo] === undefined ? c.rotulo : `${c.rotulo} (${c.idx})`;
        extrasLinha[chaveExtra] = cel.texto;
        contexto.naoReconhecidas.get(c.norm).linhas++;
      }
    }
    for (const nome of ["setor_planilha", "entidade", "situacao"]) {
      const t = textoDe(nome);
      if (t) extrasLinha[mapa[nome].rotulo] = t;
    }
    for (const nome of ["email", "telefone", "whatsapp", "responsavel"]) {
      const v = campo(nome)?.cell?.value;
      if (v && typeof v === "object" && v.hyperlink) extrasLinha[`${mapa[nome].rotulo} (link)`] = String(v.hyperlink);
    }
    if (tel.outros?.length) extrasLinha[`${mapa.telefone.rotulo} (outros números)`] = tel.outros.join(", ");
    if (whats.outros?.length) extrasLinha[`${mapa.whatsapp.rotulo} (outros números)`] = whats.outros.join(", ");

    // Campos promovidos (decisão do usuário, 2026-09-09)
    const inexistenteTexto = textoDe("contato_inexistente");
    let cadastroCrm = null;
    const crmTexto = textoDe("cadastro_crm");
    if (crmTexto) {
      cadastroCrm = booleanoDeTexto(crmTexto);
      if (cadastroCrm === null) extrasLinha[`${mapa.cadastro_crm.rotulo} (texto)`] = crmTexto;
    }

    const consultorTexto = textoDe("consultor");
    resumo.linhas.push({
      pessoa_id: consultorTexto ? contexto.consultores.get(normalizarRotulo(consultorTexto)) ?? null : null,
      curso: textoDe("curso"),
      contato_inexistente: inexistenteTexto ? 1 : 0,
      contato_inexistente_texto: inexistenteTexto,
      cadastro_crm: cadastroCrm,
      uf, setor: ws.name, linha_origem: r, orgao,
      municipio_texto: textoDe("municipio"),
      telefone_original: tel.original, telefone: tel.digitos, telefone_valido: tel.valido,
      whatsapp_original: whats.original, whatsapp: whats.digitos,
      responsavel: textoDe("responsavel"), cargo: textoDe("cargo"), email: textoDe("email"),
      data_ultimo_contato: data, observacoes: textoDe("observacoes"),
      consultor_planilha: textoDe("consultor"),
      cor_linha: corLinha, cores_celulas_json: Object.keys(coresCelulas).length ? JSON.stringify(coresCelulas) : null,
      linha_oculta: row.hidden ? 1 : 0,
      extras_json: Object.keys(extrasLinha).length ? JSON.stringify(extrasLinha) : null,
    });
    resumo.importadas++;
    if (row.hidden) resumo.ocultas++;
  });
  resumo.avisos = [...avisosAba];
  return resumo;
}

// ---------- Importação ----------

const COLUNAS_CONTATO = [
  "uf", "setor", "linha_origem", "orgao", "municipio_texto", "telefone_original", "telefone", "telefone_valido",
  "whatsapp_original", "whatsapp", "responsavel", "cargo", "email", "data_ultimo_contato", "observacoes",
  "consultor_planilha", "cor_linha", "cores_celulas_json", "linha_oculta", "extras_json",
  "curso", "contato_inexistente", "contato_inexistente_texto", "cadastro_crm", "pessoa_id",
];

// Consultor atual: só a equipe de hoje vira pessoa_id (decisão do usuário,
// 2026-09-09); qualquer outra grafia fica sem consultor.
const CONSULTORES_ATUAIS = ["Frederico", "Renato", "Eduardo", "Agnes", "Bianca"];
function mapaConsultores() {
  const mapa = new Map();
  const marcadores = CONSULTORES_ATUAIS.map(() => "?").join(",");
  for (const p of db.prepare(`SELECT id, nome, wallet_nome, nomes_alternativos FROM pessoas WHERE nome IN (${marcadores})`).all(...CONSULTORES_ATUAIS)) {
    for (const n of [p.nome, p.wallet_nome, ...JSON.parse(p.nomes_alternativos || "[]")]) if (n) mapa.set(normalizarRotulo(n), p.id);
  }
  return mapa;
}
function consultoresAtuais() {
  const marcadores = CONSULTORES_ATUAIS.map(() => "?").join(",");
  return db.prepare(`SELECT id, nome FROM pessoas WHERE nome IN (${marcadores}) ORDER BY nome`).all(...CONSULTORES_ATUAIS);
}

function linhaIdentica(existente, nova) {
  for (const c of COLUNAS_CONTATO) if ((existente[c] ?? null) !== (nova[c] ?? null)) return false;
  return true;
}

// ---------- Abas bloqueadas por edição no sistema ----------
// Aba com linha editada no jonIAs é recusada na reimportação (o sistema virou a
// fonte). O admin pode sobrescrever mesmo assim, mas só depois de VER o que se
// perde: `previaSobrescrita` compara, linha a linha, o valor atual das linhas
// editadas com o que a planilha traz. Não se perde (e a prévia diz): contato
// criado no sistema (linha_origem negativa, nenhuma linha da planilha casa),
// linha editada que sumiu da planilha (nunca há DELETE), histórico e marcações.
//
// A `assinatura` (nº de linhas editadas + última edição) amarra a confirmação
// à prévia que o admin viu: se alguém editou a aba no meio-tempo, a
// sobrescrita é recusada de novo, com prévia nova — nada some sem ser mostrado.
const LIMITE_PERDAS_NA_PREVIA = 300;

function assinaturaAba(uf, setor) {
  const r = db.prepare(
    "SELECT COUNT(*) n, MAX(editado_em) ultima FROM contatos_ativo WHERE uf = ? AND setor = ? AND editado_em IS NOT NULL"
  ).get(uf, setor);
  return `${r.n}:${r.ultima || ""}`;
}

// pessoa_id: a planilha sem consultor casado NÃO apaga o consultor atual (a
// atribuição por carteira não marca editado_em e sumiria em silêncio a cada
// reimportação). Com consultor na planilha, a planilha vale.
function mesclarConsultor(existente, nova) {
  if (existente && existente.pessoa_id != null && nova.pessoa_id == null) return { ...nova, pessoa_id: existente.pessoa_id };
  return nova;
}

function diferencas(existente, nova) {
  return COLUNAS_CONTATO.filter((c) => (existente[c] ?? null) !== (nova[c] ?? null));
}

function previaSobrescrita(uf, aba) {
  const nomeStatus = new Map(db.prepare("SELECT cor_hex, status_nome FROM cores_prospeccao").all().map((r) => [r.cor_hex, r.status_nome]));
  const nomePessoa = new Map(db.prepare("SELECT id, nome FROM pessoas").all().map((r) => [r.id, r.nome]));
  const nomeUsuario = new Map(db.prepare("SELECT id, COALESCE(nome, login) nome FROM usuarios").all().map((r) => [r.id, r.nome]));
  const legivel = (campo, v) => {
    if (v === null || v === undefined || v === "") return "";
    if (campo === "cor_linha") return nomeStatus.get(v) ? `${nomeStatus.get(v)} (#${v})` : `#${v}`;
    if (campo === "pessoa_id") return nomePessoa.get(v) || `#${v}`;
    if (["linha_oculta", "contato_inexistente", "cadastro_crm", "telefone_valido"].includes(campo)) return v ? "sim" : "não";
    return String(v);
  };
  const editadas = db.prepare(
    "SELECT * FROM contatos_ativo WHERE uf = ? AND setor = ? AND editado_em IS NOT NULL ORDER BY linha_origem"
  ).all(uf, aba.aba);
  const daPlanilha = new Map(aba.linhas.map((l) => [l.linha_origem, l]));
  const perdas = [];
  const porCampo = {};
  let linhasComPerda = 0, camposPerdidos = 0, manuais = 0, semLinhaNaPlanilha = 0, semPerda = 0;
  for (const atual of editadas) {
    if (atual.origem === "manual" || atual.linha_origem < 0) { manuais++; continue; }
    const nova = daPlanilha.get(atual.linha_origem);
    if (!nova) { semLinhaNaPlanilha++; continue; }
    // telefone/whatsapp normalizados, validade e cores por célula mudam junto
    // com o original — a prévia mostra só o campo que a pessoa vê
    const campos = diferencas(atual, mesclarConsultor(atual, nova))
      .filter((c) => !["telefone", "whatsapp", "telefone_valido", "cores_celulas_json"].includes(c));
    if (!campos.length) { semPerda++; continue; }
    linhasComPerda++;
    for (const c of campos) {
      camposPerdidos++;
      porCampo[c] = (porCampo[c] || 0) + 1;
      if (perdas.length < LIMITE_PERDAS_NA_PREVIA) {
        perdas.push({
          contatoId: atual.id, linha: atual.linha_origem,
          contato: [atual.municipio_texto, atual.responsavel].filter(Boolean).join(" · "),
          campo: c, atual: legivel(c, atual[c]), planilha: legivel(c, nova[c]),
          editadoEm: atual.editado_em, editadoPor: nomeUsuario.get(atual.editado_por) || null,
        });
      }
    }
  }
  return {
    aba: aba.aba, assinatura: assinaturaAba(uf, aba.aba), editadas: editadas.length,
    linhasComPerda, camposPerdidos, porCampo, semPerda, manuais, semLinhaNaPlanilha,
    perdas, truncado: camposPerdidos > perdas.length,
  };
}

// opcoes.sobrescrever: { [aba]: assinatura } — SÓ admin (conferido na rota).
async function importarProspeccao(buffer, arquivoNome, uf, usuarioId, opcoes = {}) {
  const sobrescrever = opcoes.sobrescrever || {};
  const iniciadoEm = new Date().toISOString();
  const hash = hashSha256(buffer);
  const relatorio = novoRelatorio();
  uf = String(uf || "").toUpperCase();
  if (!UFS_ACEITAS.includes(uf)) {
    return registrarImportacaoErro("prospeccao", arquivoNome, hash, usuarioId, iniciadoEm, `UF inválida: "${uf}".`);
  }
  avisarSeReimportacao(relatorio, hash);
  const tempos = {}; // ms por etapa — vai para o relatório (auditoria de desempenho)
  let marca = Date.now();

  let workbook, brutos;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    tempos.leitura = Date.now() - marca; marca = Date.now();
    brutos = await valoresBrutosPorAba(buffer);
    tempos.xmlBruto = Date.now() - marca; marca = Date.now();
  } catch (err) {
    return registrarImportacaoErro("prospeccao", arquivoNome, hash, usuarioId, iniciadoEm, `Arquivo ilegível como .xlsx: ${err.message}`);
  }
  const tema = paletaDoTema(workbook);
  const contexto = { cores: new Map(), naoReconhecidas: new Map(), consultores: mapaConsultores() };
  const abas = [];
  for (const ws of workbook.worksheets) {
    if (ws.state !== "visible" && ws.rowCount === 0) {
      abas.push({ aba: ws.name, motivo: "aba oculta e vazia", importadas: 0, linhasLidas: 0 });
      continue;
    }
    try {
      const resumo = lerAba(ws, uf, brutos.get(ws.name), tema, contexto);
      if (resumo.oculta && resumo.importadas) resumo.avisos.push("aba oculta na planilha — importada mesmo assim");
      abas.push(resumo);
    } catch (err) {
      abas.push({ aba: ws.name, motivo: `erro de leitura: ${err.message}`, importadas: 0, linhasLidas: 0 });
    }
  }

  tempos.abas = Date.now() - marca; marca = Date.now();

  // Abas com edição feita no jonIAs não podem ser sobrescritas pela planilha
  const bloqueadas = new Set(
    db.prepare("SELECT DISTINCT setor FROM contatos_ativo WHERE uf = ? AND editado_em IS NOT NULL").all(uf).map((r) => r.setor)
  );

  const buscar = db.prepare("SELECT * FROM contatos_ativo WHERE uf = ? AND setor = ? AND linha_origem = ?");
  const inserir = db.prepare(
    `INSERT INTO contatos_ativo (${COLUNAS_CONTATO.join(", ")}, arquivo_nome, importacao_id, criado_em)
     VALUES (${COLUNAS_CONTATO.map((c) => "@" + c).join(", ")}, @arquivo_nome, @importacao_id, @criado_em)`
  );
  const atualizar = db.prepare(
    `UPDATE contatos_ativo SET ${COLUNAS_CONTATO.filter((c) => !["uf", "setor", "linha_origem"].includes(c)).map((c) => `${c} = @${c}`).join(", ")},
       arquivo_nome = @arquivo_nome, importacao_id = @importacao_id, atualizado_em = @criado_em
     WHERE uf = @uf AND setor = @setor AND linha_origem = @linha_origem`
  );
  const upsertCor = db.prepare(
    `INSERT INTO cores_prospeccao (cor_hex, origem) VALUES (?, ?)
     ON CONFLICT(cor_hex) DO UPDATE SET origem = COALESCE(cores_prospeccao.origem, excluded.origem)`
  );

  let novos = 0, atualizados = 0, identicos = 0, lidas = 0, vazias = 0, importadas = 0, historicoSobrescrita = 0;
  const bloqueios = [];
  let resultado;
  try {
    resultado = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO importacoes (tipo, arquivo_nome, hash_sha256, usuario_id, iniciado_em)
         VALUES ('prospeccao', ?, ?, ?, ?)`
      ).run(arquivoNome, hash, usuarioId, iniciadoEm);
      const importacaoId = info.lastInsertRowid;
      const agora = new Date().toISOString();
      for (const [hex, origem] of contexto.cores) upsertCor.run(hex, origem);

      for (const aba of abas) {
        lidas += aba.linhasLidas || 0;
        vazias += aba.linhasVazias || 0;
        if (aba.motivo) {
          registrarOcorrencia(relatorio.motivos, `aba não importada: ${aba.motivo}`, aba.aba);
          continue;
        }
        let sobrescrita = false;
        if (bloqueadas.has(aba.aba)) {
          const pedida = sobrescrever[aba.aba];
          if (pedida && pedida === assinaturaAba(uf, aba.aba)) {
            sobrescrita = true;
          } else {
            aba.bloqueio = "edicao";
            aba.motivo = pedida
              ? "a aba foi editada no jonIAs DEPOIS da prévia — sobrescrita recusada; revise a prévia nova"
              : "aba tem linha editada no jonIAs — reimportação recusada (o sistema é a fonte)";
            registrarOcorrencia(relatorio.motivos, "aba com edição no sistema — não sobrescrita", aba.aba);
            aba.novos = aba.atualizados = aba.identicos = 0;
            bloqueios.push(previaSobrescrita(uf, aba));
            continue;
          }
        }
        aba.novos = 0; aba.atualizados = 0; aba.identicos = 0;
        for (const lida of aba.linhas) {
          const existente = buscar.get(uf, aba.aba, lida.linha_origem);
          const linha = mesclarConsultor(existente, lida);
          const registro = { ...linha, arquivo_nome: arquivoNome, importacao_id: importacaoId, criado_em: agora };
          if (!existente) { inserir.run(registro); aba.novos++; novos++; }
          else if (linhaIdentica(existente, linha)) { aba.identicos++; identicos++; }
          else {
            // Sobrescrita confirmada: o valor editado no sistema vai para o
            // histórico antes de ser trocado — a perda fica auditável.
            if (sobrescrita && existente.editado_em) {
              for (const c of diferencas(existente, linha)) {
                inserirHistorico.run({
                  contato_id: existente.id, tipo: CAMPOS_STATUS.has(c) ? "status" : "edicao", canal: null, campo: c,
                  valor_anterior: existente[c] == null ? null : String(existente[c]),
                  valor_novo: linha[c] == null ? null : String(linha[c]),
                  observacao: `sobrescrito pela planilha "${arquivoNome}" (importação #${importacaoId}, confirmada pelo admin)`,
                  usuario_id: usuarioId, registrado_em: agora,
                });
                historicoSobrescrita++;
              }
            }
            atualizar.run(registro); aba.atualizados++; atualizados++;
          }
          importadas++;
        }
        if (sobrescrita) {
          aba.sobrescrita = true;
          aba.avisos = [...(aba.avisos || []), "aba com edição no sistema SOBRESCRITA por confirmação do admin — valores anteriores no histórico"];
        }
        for (const a of aba.avisos || []) registrarOcorrencia(relatorio.problemas, a, aba.aba);
      }

      tempos.gravacao = Date.now() - marca; marca = Date.now();

      // Contadores das cores: um GROUP BY por tipo (a versão com subconsulta
      // correlacionada por cor lia o JSON de todas as linhas 180×)
      db.exec("UPDATE cores_prospeccao SET linhas = 0, celulas = 0");
      const porLinha = db.prepare("SELECT cor_linha hex, COUNT(*) n FROM contatos_ativo WHERE cor_linha IS NOT NULL GROUP BY 1").all();
      const porCelula = db.prepare(
        `SELECT j.value hex, COUNT(*) n FROM contatos_ativo c, json_each(c.cores_celulas_json) j
         WHERE c.cores_celulas_json IS NOT NULL GROUP BY 1`
      ).all();
      const setLinhas = db.prepare("UPDATE cores_prospeccao SET linhas = ? WHERE cor_hex = ?");
      const setCelulas = db.prepare("UPDATE cores_prospeccao SET celulas = ? WHERE cor_hex = ?");
      for (const r of porLinha) setLinhas.run(r.n, r.hex);
      for (const r of porCelula) setCelulas.run(r.n, r.hex);
      tempos.cores = Date.now() - marca; marca = Date.now();

      // Casamento com o município (compartilha apelidos com as matrículas)
      const cruzamento = cruzarMunicipios();
      tempos.cruzamento = Date.now() - marca; marca = Date.now();

      // Mesma regra de gravarCarteira: contato das abas importadas que ficou
      // sem consultor e cujo município (regional principal) tem titular passa
      // para o titular — depois do casamento, que é o que define o município.
      // Não marca editado_em (atribuição não é edição; não bloqueia reimportação).
      const setoresImportados = abas.filter((a) => !a.motivo).map((a) => a.aba);
      const atribuicoes = {};
      if (setoresImportados.length) {
        const semDono = db.prepare(
          `SELECT c.id, ca.pessoa_id titular, r.sigla FROM contatos_ativo c
             JOIN municipios m ON m.codigo_ibge = c.codigo_ibge
             JOIN regionais r ON r.id = m.regional_principal_id
             JOIN carteiras ca ON ca.regional_id = r.id AND ca.papel = 'titular'
           WHERE c.uf = ? AND c.pessoa_id IS NULL AND c.setor IN (${setoresImportados.map(() => "?").join(",")})`
        ).all(uf, ...setoresImportados);
        const atribuir = db.prepare("UPDATE contatos_ativo SET pessoa_id = ?, atualizado_em = ? WHERE id = ?");
        for (const c of semDono) {
          atribuir.run(c.titular, agora, c.id);
          inserirHistorico.run({ contato_id: c.id, tipo: "edicao", canal: null, campo: "pessoa_id", valor_anterior: null,
            valor_novo: String(c.titular),
            observacao: `atribuído ao titular da regional ${c.sigla} na importação da planilha "${arquivoNome}" (importação #${importacaoId})`,
            usuario_id: usuarioId, registrado_em: agora });
          atribuicoes[c.sigla] = (atribuicoes[c.sigla] || 0) + 1;
        }
      }
      relatorio.atribuidosTitular = atribuicoes;
      tempos.atribuicao = Date.now() - marca; marca = Date.now();

      relatorio.uf = uf;
      relatorio.abas = abas.map(({ linhas, ...resto }) => resto); // sem as linhas (vão para a tabela)
      relatorio.colunasNaoReconhecidas = [...contexto.naoReconhecidas.values()]
        .map((g) => ({ rotulo: g.rotulo, abas: [...g.abas], linhas: g.linhas }))
        .sort((a, b) => b.abas.length - a.abas.length || b.linhas - a.linhas);
      relatorio.cores = [...contexto.cores].map(([hex, origem]) => ({ hex, origem }));
      relatorio.municipios = coberturaMunicipiosDaImportacao(uf, abas.filter((a) => !a.motivo).map((a) => a.aba));
      tempos.relatorio = Date.now() - marca;
      relatorio.tempos = tempos;
      relatorio.resumoAbas = {
        total: abas.length,
        importadas: abas.filter((a) => !a.motivo).length,
        recusadasPorEdicao: abas.filter((a) => a.bloqueio === "edicao").length,
        outrasNaoImportadas: abas.filter((a) => a.motivo && a.bloqueio !== "edicao").length,
        sobrescritas: abas.filter((a) => a.sobrescrita).map((a) => a.aba),
        historicoSobrescrita,
      };
      relatorio.bloqueios = bloqueios;
      relatorio.avisos.push(
        `${abas.length} aba(s) no arquivo: ${relatorio.resumoAbas.importadas} importada(s), ${relatorio.resumoAbas.recusadasPorEdicao} recusada(s) por edição no sistema, ${relatorio.resumoAbas.outrasNaoImportadas} não importada(s) por outro motivo (listadas em "Linhas ignoradas").`,
        `Cores distintas encontradas: ${contexto.cores.size} — dê nome e significado a cada uma em /prospeccao (nenhum significado foi presumido).`,
        `Casamento cidade → município: ${cruzamento.apelidosNovos} chave(s) nova(s); pendências ficam na revisão de /territorio.`,
        Object.keys(atribuicoes).length
          ? `Contatos sem consultor atribuídos ao titular da regional: ${Object.values(atribuicoes).reduce((a, b) => a + b, 0)} (${Object.entries(atribuicoes).map(([s, n]) => `${s} ${n}`).join(", ")}) — registrado no histórico de cada contato.`
          : "Nenhum contato sem consultor em regional com titular — nada atribuído."
      );

      db.prepare(
        `UPDATE importacoes SET linhas_lidas = ?, linhas_validas = ?, linhas_ignoradas = ?,
           registros_novos = ?, registros_atualizados = ?, registros_identicos = ?,
           detalhes_json = ?, concluido_em = ? WHERE id = ?`
      ).run(lidas, importadas, lidas - importadas, novos, atualizados, identicos,
        JSON.stringify(relatorio), new Date().toISOString(), importacaoId);
      return { importacaoId };
    })();
  } catch (err) {
    return registrarImportacaoErro("prospeccao", arquivoNome, hash, usuarioId, iniciadoEm, `Falha ao gravar no banco: ${err.message}`);
  }

  // Fase 4: telefones novos/alterados mudam a classificação das ligações do CDR
  relatorio.ligacoes = cdr.cruzarLigacoes();
  db.prepare("UPDATE importacoes SET detalhes_json = ? WHERE id = ?").run(JSON.stringify(relatorio), resultado.importacaoId);

  return {
    status: "concluida", importacaoId: resultado.importacaoId, tipo: "prospeccao", arquivo: arquivoNome, uf,
    linhasLidas: lidas, linhasValidas: importadas, linhasIgnoradas: lidas - importadas,
    registrosNovos: novos, registrosAtualizados: atualizados, registrosIdenticos: identicos,
    abas: relatorio.abas, resumoAbas: relatorio.resumoAbas, bloqueios: relatorio.bloqueios, detalhes: relatorio,
  };
}

// ---------- Cobertura, cores e consultas para as telas ----------

const SQL_GRUPO_MUNICIPIO = `CASE
  WHEN municipio_metodo IS NULL THEN 'nao_processado'
  WHEN codigo_ibge IS NOT NULL THEN 'casado'
  WHEN municipio_metodo IN ('fora_uf', 'fora_cep', 'fora_brasil', 'manual_fora') THEN 'fora'
  WHEN municipio_metodo = 'sem_cidade' THEN 'sem_cidade'
  WHEN municipio_metodo = 'manual_ignorar' THEN 'ignorado'
  ELSE 'pendente' END`;

function coberturaMunicipiosDaImportacao(uf, setores) {
  if (!setores.length) return {};
  const marcadores = setores.map(() => "?").join(",");
  return Object.fromEntries(
    db.prepare(
      `SELECT ${SQL_GRUPO_MUNICIPIO} grupo, COUNT(*) n FROM contatos_ativo
       WHERE uf = ? AND setor IN (${marcadores}) GROUP BY 1`
    ).all(uf, ...setores).map((r) => [r.grupo, r.n])
  );
}

function coberturaProspeccao() {
  const porAba = db.prepare(
    `SELECT uf, setor, orgao, COUNT(*) linhas, SUM(linha_oculta) ocultas,
            SUM(telefone_valido = 1) telefonesValidos, SUM(telefone_valido = 0) telefonesInvalidos,
            SUM(telefone IS NULL) telefonesVazios, SUM(whatsapp IS NOT NULL) whatsapps,
            SUM(codigo_ibge IS NOT NULL) municipiosCasados,
            SUM(${SQL_GRUPO_MUNICIPIO} = 'pendente') municipiosPendentes,
            SUM(municipio_texto IS NULL) semMunicipio,
            SUM(email IS NOT NULL) emails, SUM(data_ultimo_contato IS NOT NULL) comData,
            COUNT(DISTINCT cor_linha) cores, SUM(cor_linha IS NULL) semCor,
            SUM(editado_em IS NOT NULL) editadas, MAX(atualizado_em) atualizadoEm, MAX(criado_em) criadoEm
     FROM contatos_ativo GROUP BY uf, setor ORDER BY uf, setor`
  ).all();
  const porUf = db.prepare(
    `SELECT uf, COUNT(*) linhas, COUNT(DISTINCT setor) abas, SUM(linha_oculta) ocultas,
            SUM(telefone_valido = 1) telefonesValidos, SUM(codigo_ibge IS NOT NULL) municipiosCasados,
            SUM(${SQL_GRUPO_MUNICIPIO} = 'pendente') municipiosPendentes,
            COUNT(DISTINCT codigo_ibge) municipiosDistintos, COUNT(DISTINCT cor_linha) cores
     FROM contatos_ativo GROUP BY uf ORDER BY uf`
  ).all();
  const municipiosPorGrupo = db.prepare(
    `SELECT uf, ${SQL_GRUPO_MUNICIPIO} grupo, COUNT(*) n FROM contatos_ativo GROUP BY 1, 2`
  ).all();
  // Colunas não reconhecidas: da importação mais recente de cada UF
  const naoReconhecidas = {};
  for (const imp of db.prepare(
    `SELECT detalhes_json FROM importacoes i
     WHERE tipo = 'prospeccao' AND status = 'concluida'
       AND id = (SELECT MAX(id) FROM importacoes x WHERE x.tipo = 'prospeccao' AND x.status = 'concluida'
                 AND json_extract(x.detalhes_json, '$.uf') = json_extract(i.detalhes_json, '$.uf'))`
  ).all()) {
    try {
      const d = JSON.parse(imp.detalhes_json);
      naoReconhecidas[d.uf] = { colunas: d.colunasNaoReconhecidas || [], abasNaoImportadas: (d.abas || []).filter((a) => a.motivo) };
    } catch (_) { /* detalhes ilegíveis */ }
  }
  const status = db.prepare(
    `SELECT COUNT(*) cores, SUM(status_nome IS NOT NULL) nomeadas, SUM(ignorar) ignoradas FROM cores_prospeccao`
  ).get();
  return { porUf, porAba, municipiosPorGrupo, naoReconhecidas, status };
}

function listarCores() {
  const cores = db.prepare(
    `SELECT cor_hex hex, origem, linhas, celulas, status_nome statusNome, significado, ignorar, ordem, atualizado_em atualizadoEm
     FROM cores_prospeccao ORDER BY ignorar, linhas DESC, celulas DESC`
  ).all();
  // Uma consulta por tipo de informação (não uma por cor): 180 cores × 26 k
  // linhas com ORDER BY RANDOM()/json_each levava segundos por chamada.
  const exemplos = db.prepare(
    `SELECT setor, uf, municipio_texto municipio, responsavel, telefone_original telefone, observacoes
     FROM contatos_ativo WHERE cor_linha = ? AND municipio_texto IS NOT NULL LIMIT ${EXEMPLOS_POR_COR}`
  );
  const porCelula = new Map();
  for (const l of db.prepare(
    `SELECT j.value hex, c.setor, c.uf, c.municipio_texto municipio, j.key campo
     FROM contatos_ativo c, json_each(c.cores_celulas_json) j WHERE c.cores_celulas_json IS NOT NULL`
  ).all()) {
    const lista = porCelula.get(l.hex) ?? porCelula.set(l.hex, []).get(l.hex);
    if (lista.length < 3) lista.push(l);
  }
  const porAba = new Map();
  for (const l of db.prepare(
    `SELECT cor_linha hex, uf || ' · ' || setor aba, COUNT(*) n FROM contatos_ativo
     WHERE cor_linha IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC`
  ).all()) {
    const lista = porAba.get(l.hex) ?? porAba.set(l.hex, []).get(l.hex);
    if (lista.length < 6) lista.push({ aba: l.aba, n: l.n });
  }
  return cores.map((c) => ({
    ...c, ignorar: Boolean(c.ignorar),
    exemplos: exemplos.all(c.hex), exemplosCelula: porCelula.get(c.hex) || [], abas: porAba.get(c.hex) || [],
  }));
}

function definirStatusCor(hex, { statusNome, significado, ignorar }, usuarioId) {
  const cor = String(hex || "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(cor)) throw erro("Cor inválida.");
  if (!db.prepare("SELECT 1 FROM cores_prospeccao WHERE cor_hex = ?").get(cor)) throw erro("Cor não encontrada.");
  const nome = statusNome === undefined ? undefined : String(statusNome || "").trim() || null;
  const sig = significado === undefined ? undefined : String(significado || "").trim() || null;
  db.prepare(
    `UPDATE cores_prospeccao SET
       status_nome = CASE WHEN @nomeDefinido THEN @nome ELSE status_nome END,
       significado = CASE WHEN @sigDefinido THEN @sig ELSE significado END,
       ignorar = CASE WHEN @ignDefinido THEN @ignorar ELSE ignorar END,
       atualizado_em = @agora, usuario_id = @usuario
     WHERE cor_hex = @cor`
  ).run({
    cor, nome: nome ?? null, nomeDefinido: nome === undefined ? 0 : 1, sig: sig ?? null, sigDefinido: sig === undefined ? 0 : 1,
    ignorar: ignorar ? 1 : 0, ignDefinido: ignorar === undefined ? 0 : 1, agora: new Date().toISOString(), usuario: usuarioId,
  });
  return listarCores().find((c) => c.hex === cor);
}

function erro(mensagem) {
  const e = new Error(mensagem);
  e.validacao = true;
  return e;
}

// ======================================================================
// Fase 2 — tela de trabalho: payload compacto, edição, histórico, criação,
// status novos e exportação .xlsx
// ======================================================================

// Ordem das colunas do payload compacto (array de arrays: 16 k linhas ≈ 2 MB)
const CAMPOS_TRABALHO = [
  "id", "setor", "orgao", "municipio_texto", "codigo_ibge", "responsavel", "cargo", "telefone",
  "telefone_original", "whatsapp", "email", "data_ultimo_contato", "observacoes", "curso",
  "consultor_planilha", "pessoa_id", "cor_linha", "contato_inexistente", "cadastro_crm", "linha_oculta",
  "origem", "editado_em", "telefone_valido",
];
const SQL_LINHA_TRABALHO = `SELECT ${CAMPOS_TRABALHO.join(", ")} FROM contatos_ativo`;
const linhaCompacta = (r) => CAMPOS_TRABALHO.map((c) => r[c] ?? null);

// Vendedor: identidade de terceiros mascarada NO SQL — pessoa_id de outro
// consultor vira -1 ("outro consultor") e o texto do consultor da planilha não
// sai do banco. Admin: colunas como estão.
function sqlLinhaTrabalho(escopo) {
  if (!escopo) return { sql: SQL_LINHA_TRABALHO, valores: [] };
  const colunas = CAMPOS_TRABALHO.map((c) => {
    if (c === "pessoa_id") return "CASE WHEN pessoa_id IS NULL THEN NULL WHEN pessoa_id = ? THEN pessoa_id ELSE -1 END AS pessoa_id";
    if (c === "consultor_planilha") return "NULL AS consultor_planilha";
    return c;
  });
  return { sql: `SELECT ${colunas.join(", ")} FROM contatos_ativo`, valores: [escopo.pessoaId ?? -2] };
}

function statusDisponiveis() {
  return db.prepare(
    `SELECT cor_hex hex, status_nome nome, significado, linhas, origem FROM cores_prospeccao
     WHERE status_nome IS NOT NULL AND ignorar = 0 ORDER BY ordem, linhas DESC`
  ).all();
}

// escopo (escopo.js): null = admin (UF inteira); vendedor = só municípios das
// regionais dele — o filtro entra no SQL, e as listas auxiliares (regionais,
// municípios, setores, consultores) também são cortadas.
function payloadTrabalho(uf, usuario, escopo = null) {
  uf = String(uf || "").toUpperCase();
  if (!UFS_ACEITAS.includes(uf)) throw erro("UF inválida.");
  const cm = clausulaMunicipios(escopo);
  const sl = sqlLinhaTrabalho(escopo);
  const linhas = db.prepare(`${sl.sql} WHERE uf = ? AND ${cm.sql} ORDER BY setor, linha_origem, id`)
    .all(...sl.valores, uf, ...cm.valores).map(linhaCompacta);
  const regionais = escopo
    ? db.prepare(`SELECT id, sigla, nome FROM regionais WHERE uf = ? AND id IN (${escopo.regionais.map(() => "?").join(",") || "NULL"}) ORDER BY sigla`).all(uf, ...escopo.regionais)
    : db.prepare("SELECT id, sigla, nome FROM regionais WHERE uf = ? ORDER BY sigla").all(uf);
  const municipios = Object.fromEntries(
    db.prepare(`SELECT codigo_ibge codigo, nome, regional_principal_id regional FROM municipios WHERE uf = ? AND ${cm.sql} ORDER BY nome`)
      .all(uf, ...cm.valores).map((m) => [m.codigo, [m.nome, m.regional]])
  );
  const setores = db.prepare(`SELECT DISTINCT setor FROM contatos_ativo WHERE uf = ? AND ${cm.sql} ORDER BY setor`).all(uf, ...cm.valores).map((s) => s.setor);
  const consultores = escopo
    ? (escopo.pessoaId ? db.prepare("SELECT id, nome FROM pessoas WHERE id = ?").all(escopo.pessoaId) : [])
    : consultoresAtuais();
  return {
    uf, campos: CAMPOS_TRABALHO, linhas, status: statusDisponiveis(), setores, regionais, municipios, consultores,
    // Fase 4 (só leitura): por município [última, total, atendidas, quem ligou por último]; por contato [última, total]
    cdr: cdr.cdrPorMunicipio(uf, escopo),
    // marcação pessoal (verde/vermelho) SÓ do usuário logado: { contatoId: cor }
    marcacoes: marcacoesDoUsuario(uf, usuario.id, escopo),
    // admin: quem mais marcou nesta UF (para ver as marcações de outro usuário, só leitura)
    marcacoesDe: escopo ? null : usuariosComMarcacoes(uf, usuario.id),
    usuario: { id: usuario.id, nome: usuario.nome || usuario.login, papel: usuario.papel, pessoaId: usuario.pessoa_id ?? null },
    escopo: escopo ? { regionais: escopo.regionais, ufs: escopo.ufs, vazio: escopo.vazio } : null,
    geradoEm: new Date().toISOString(),
  };
}

const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const RE_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const texto = (v, max = 4000) => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\s+$/g, "").trim();
  return t ? t.slice(0, max) : null;
};

// Validadores por campo editável: devolvem { colunas: {coluna: valor}, log: valorNovo }
const EDITAVEIS = {
  responsavel: (v) => ({ responsavel: texto(v, 200) }),
  cargo: (v) => ({ cargo: texto(v, 200) }),
  email: (v) => ({ email: texto(v, 200) }),
  observacoes: (v) => ({ observacoes: texto(v) }),
  curso: (v) => ({ curso: texto(v, 300) }),
  setor: (v) => {
    const s = texto(v, 120);
    if (!s) throw erro("Setor não pode ficar vazio.");
    return { setor: s, orgao: orgaoDaAba(s) };
  },
  telefone: (v) => {
    const t = normalizarTelefoneOriginal(texto(v, 100));
    return { telefone_original: t.original, telefone: t.digitos, telefone_valido: t.valido };
  },
  whatsapp: (v) => {
    const t = normalizarTelefoneOriginal(texto(v, 100));
    return { whatsapp_original: t.original, whatsapp: t.digitos };
  },
  data_ultimo_contato: (v) => {
    const d = texto(v, 10);
    if (d && !RE_DATA_ISO.test(d)) throw erro("Data inválida — use AAAA-MM-DD.");
    return { data_ultimo_contato: d };
  },
  cor_linha: (v) => {
    const hex = v === null || v === "" ? null : String(v).toUpperCase();
    if (hex && !db.prepare("SELECT 1 FROM cores_prospeccao WHERE cor_hex = ? AND status_nome IS NOT NULL AND ignorar = 0").get(hex)) {
      throw erro("Status inválido — escolha um da lista (cor nomeada em /prospeccao).");
    }
    return { cor_linha: hex };
  },
  pessoa_id: (v) => {
    const id = v === null || v === "" ? null : Number(v);
    if (id !== null && !consultoresAtuais().some((c) => c.id === id)) throw erro("Consultor inválido — só a equipe atual.");
    return { pessoa_id: id };
  },
  contato_inexistente: (v) => ({ contato_inexistente: v ? 1 : 0 }),
  cadastro_crm: (v) => ({ cadastro_crm: v === null || v === "" ? null : v ? 1 : 0 }),
  linha_oculta: (v) => ({ linha_oculta: v ? 1 : 0 }),
  codigo_ibge: (v, linha) => {
    const codigo = v === null || v === "" ? null : Number(v);
    if (codigo === null) return { codigo_ibge: null, municipio_metodo: "manual_ignorar", municipio_confianca: "manual" };
    const m = db.prepare("SELECT nome, uf FROM municipios WHERE codigo_ibge = ?").get(codigo);
    if (!m) throw erro("Município inexistente.");
    if (m.uf !== linha.uf) throw erro(`Município de ${m.uf}; a carteira é de ${linha.uf}.`);
    return { codigo_ibge: codigo, municipio_texto: m.nome, municipio_metodo: "manual", municipio_confianca: "manual" };
  },
};
const CAMPOS_STATUS = new Set(["cor_linha", "contato_inexistente"]);

const inserirHistorico = db.prepare(
  `INSERT INTO contatos_ativo_historico (contato_id, tipo, canal, campo, valor_anterior, valor_novo, observacao, usuario_id, registrado_em)
   VALUES (@contato_id, @tipo, @canal, @campo, @valor_anterior, @valor_novo, @observacao, @usuario_id, @registrado_em)`
);

// Linha fora do escopo do vendedor responde como inexistente (404) — não
// revela que o id existe
function buscarLinha(id, escopo = null) {
  const linha = db.prepare("SELECT * FROM contatos_ativo WHERE id = ?").get(Number(id));
  if (!linha || !dentroDoEscopo(escopo, linha.codigo_ibge)) throw Object.assign(new Error("Contato não encontrado."), { naoEncontrado: true });
  return linha;
}

function linhaCompactaDe(id, escopo = null) {
  const sl = sqlLinhaTrabalho(escopo);
  return linhaCompacta(db.prepare(`${sl.sql} WHERE id = ?`).get(...sl.valores, Number(id)));
}

// PATCH: { campo: valor, ... } — valida tudo, grava, registra histórico por campo
function atualizarContato(id, mudancas, usuarioId, escopo = null) {
  const linha = buscarLinha(id, escopo);
  const campos = Object.keys(mudancas || {}).filter((c) => c !== "id");
  if (!campos.length) throw erro("Nenhum campo para alterar.");
  const desconhecido = campos.find((c) => !EDITAVEIS[c]);
  if (desconhecido) throw erro(`Campo não editável: ${desconhecido}.`);
  if (escopo) {
    // vendedor: só atribui a si mesmo (ou tira), e não move a linha para fora da regional
    if (campos.includes("pessoa_id") && mudancas.pessoa_id !== null && mudancas.pessoa_id !== "" && Number(mudancas.pessoa_id) !== escopo.pessoaId) {
      throw erro("Você só pode atribuir o contato a você mesmo.");
    }
    if (campos.includes("codigo_ibge") && mudancas.codigo_ibge && !dentroDoEscopo(escopo, mudancas.codigo_ibge)) {
      throw erro("Município fora da sua regional.");
    }
  }
  const agora = new Date().toISOString();
  const colunas = {};
  const registros = [];
  for (const campo of campos) {
    const novas = EDITAVEIS[campo](mudancas[campo], linha);
    Object.assign(colunas, novas);
    const chaveLog = campo === "telefone" ? "telefone_original" : campo === "whatsapp" ? "whatsapp_original" : campo === "codigo_ibge" ? "municipio_texto" : campo;
    const anterior = linha[chaveLog] ?? null;
    const novo = novas[chaveLog] ?? null;
    if (String(anterior ?? "") !== String(novo ?? "")) {
      registros.push({ contato_id: linha.id, tipo: CAMPOS_STATUS.has(campo) ? "status" : "edicao", canal: null, campo,
        valor_anterior: anterior === null ? null : String(anterior), valor_novo: novo === null ? null : String(novo),
        observacao: null, usuario_id: usuarioId, registrado_em: agora });
    }
  }
  db.transaction(() => {
    if (registros.length) {
      const sets = Object.keys(colunas).map((c) => `${c} = @${c}`).join(", ");
      db.prepare(`UPDATE contatos_ativo SET ${sets}, editado_em = @agora, editado_por = @usuario, atualizado_em = @agora WHERE id = @id`)
        .run({ ...colunas, agora, usuario: usuarioId, id: linha.id });
      for (const r of registros) inserirHistorico.run(r);
    }
  })();
  // Fase 4: telefone/WhatsApp/município alterados reclassificam só as ligações desses números
  if (registros.length && campos.some((c) => ["telefone", "whatsapp", "codigo_ibge"].includes(c))) {
    cdr.cruzarLigacoes({ numeros: [linha.telefone, linha.whatsapp, colunas.telefone, colunas.whatsapp].filter(Boolean) });
  }
  return { linha: linhaCompactaDe(linha.id, escopo), alteracoes: registros.length };
}

// ---------- marcação pessoal (migração 25) ----------
// Verde/vermelho por USUÁRIO, independente do status importado e do registro
// de contato: não toca contatos_ativo (nem editado_em) nem o histórico.
const CORES_MARCACAO = ["verde", "vermelho"];

function marcacoesDoUsuario(uf, usuarioId, escopo = null) {
  const cm = clausulaMunicipios(escopo, "c.codigo_ibge");
  const linhas = db.prepare(
    `SELECT m.contato_id id, m.cor FROM marcacoes_prospeccao m JOIN contatos_ativo c ON c.id = m.contato_id
     WHERE m.usuario_id = ? AND c.uf = ? AND ${cm.sql}`
  ).all(Number(usuarioId), uf, ...cm.valores);
  return Object.fromEntries(linhas.map((r) => [r.id, r.cor]));
}

function usuariosComMarcacoes(uf, exceto) {
  return db.prepare(
    `SELECT u.id, COALESCE(u.nome, u.login) nome, u.papel, COUNT(*) n FROM marcacoes_prospeccao m
     JOIN usuarios u ON u.id = m.usuario_id JOIN contatos_ativo c ON c.id = m.contato_id
     WHERE c.uf = ? AND m.usuario_id <> ? GROUP BY u.id ORDER BY nome`
  ).all(uf, Number(exceto));
}

// Admin: marcações de outro usuário numa UF (só leitura)
function marcacoesDeOutro(uf, usuarioId) {
  uf = String(uf || "").toUpperCase();
  if (!UFS_ACEITAS.includes(uf)) throw erro("UF inválida.");
  const id = Number(usuarioId);
  if (!Number.isInteger(id) || !db.prepare("SELECT 1 FROM usuarios WHERE id = ?").get(id)) {
    throw Object.assign(new Error("Usuário não encontrado."), { naoEncontrado: true });
  }
  return { uf, usuarioId: id, marcacoes: marcacoesDoUsuario(uf, id) };
}

// PUT { cor: 'verde' | 'vermelho' | null } — idempotente: grava o estado final
// pedido pelo cliente (sem alternância no servidor, então requisições repetidas
// ou reenviadas não invertem a marcação). Contato fora do escopo = 404.
function marcarContato(id, cor, usuarioId, escopo = null) {
  const linha = buscarLinha(id, escopo);
  if (cor !== null && cor !== "" && cor !== undefined && !CORES_MARCACAO.includes(cor)) {
    throw erro("Marcação inválida — use verde, vermelho ou null.");
  }
  if (!cor) {
    db.prepare("DELETE FROM marcacoes_prospeccao WHERE usuario_id = ? AND contato_id = ?").run(usuarioId, linha.id);
    return { id: linha.id, cor: null };
  }
  db.prepare(
    `INSERT INTO marcacoes_prospeccao (usuario_id, contato_id, cor, marcado_em) VALUES (?, ?, ?, ?)
     ON CONFLICT(usuario_id, contato_id) DO UPDATE SET cor = excluded.cor, marcado_em = excluded.marcado_em`
  ).run(usuarioId, linha.id, cor, new Date().toISOString());
  return { id: linha.id, cor };
}

const CANAIS = ["ligacao", "whatsapp", "email", "visita", "outro"];

// Registrar contato: histórico + data do último contato + status (opcional)
function registrarContato(id, { canal, observacao, statusHex, data }, usuarioId, escopo = null) {
  const linha = buscarLinha(id, escopo);
  if (!CANAIS.includes(canal)) throw erro(`Canal inválido — use ${CANAIS.join(", ")}.`);
  const dia = texto(data, 10) || hojeIso();
  if (!RE_DATA_ISO.test(dia)) throw erro("Data inválida — use AAAA-MM-DD.");
  const obs = texto(observacao);
  const agora = new Date().toISOString();
  let statusNovo;
  if (statusHex !== undefined && statusHex !== null && statusHex !== "") statusNovo = EDITAVEIS.cor_linha(statusHex).cor_linha;
  db.transaction(() => {
    db.prepare(
      `UPDATE contatos_ativo SET data_ultimo_contato = ?, cor_linha = COALESCE(?, cor_linha),
         editado_em = ?, editado_por = ?, atualizado_em = ? WHERE id = ?`
    ).run(dia, statusNovo ?? null, agora, usuarioId, agora, linha.id);
    inserirHistorico.run({ contato_id: linha.id, tipo: "contato", canal, campo: null,
      valor_anterior: linha.cor_linha ?? null, valor_novo: statusNovo ?? linha.cor_linha ?? null,
      observacao: obs, usuario_id: usuarioId, registrado_em: agora });
    if (statusNovo !== undefined && statusNovo !== linha.cor_linha) {
      inserirHistorico.run({ contato_id: linha.id, tipo: "status", canal: null, campo: "cor_linha",
        valor_anterior: linha.cor_linha ?? null, valor_novo: statusNovo, observacao: null, usuario_id: usuarioId, registrado_em: agora });
    }
  })();
  return { linha: linhaCompactaDe(linha.id, escopo), historico: historicoDoContato(linha.id) };
}

function historicoDoContato(id, escopo = null) {
  if (escopo) buscarLinha(id, escopo); // 404 fora do escopo
  return db.prepare(
    `SELECT h.id, h.tipo, h.canal, h.campo, h.valor_anterior valorAnterior, h.valor_novo valorNovo, h.observacao,
            h.registrado_em registradoEm, COALESCE(NULLIF(u.nome, ''), u.login) usuario,
            ca.status_nome statusAnterior, cn.status_nome statusNovo
     FROM contatos_ativo_historico h
     JOIN usuarios u ON u.id = h.usuario_id
     LEFT JOIN cores_prospeccao ca ON ca.cor_hex = h.valor_anterior AND (h.campo = 'cor_linha' OR h.tipo = 'contato')
     LEFT JOIN cores_prospeccao cn ON cn.cor_hex = h.valor_novo AND (h.campo = 'cor_linha' OR h.tipo = 'contato')
     WHERE h.contato_id = ? ORDER BY h.registrado_em DESC, h.id DESC`
  ).all(Number(id));
}

// Novo contato manual
function criarContato(dados, usuarioId, escopo = null) {
  const uf = String(dados.uf || "").toUpperCase();
  if (!UFS_ACEITAS.includes(uf)) throw erro("UF inválida.");
  const setor = texto(dados.setor, 120);
  if (!setor) throw erro("Informe o setor (aba/carteira).");
  if (escopo) {
    // vendedor: município obrigatório e dentro da regional dele; consultor só ele
    if (!dados.codigo_ibge) {
      const nome = normalizarCidade(texto(dados.municipio_texto) || "").nome;
      const cand = (indiceMunicipios().porNome.get(nome) || []).find((m) => m.uf === uf && escopo.municipios.has(m.codigo));
      if (!cand) throw erro("Informe um município da sua regional.");
      dados = { ...dados, codigo_ibge: cand.codigo };
    } else if (!dentroDoEscopo(escopo, dados.codigo_ibge)) throw erro("Município fora da sua regional.");
    if (dados.pessoa_id !== undefined && dados.pessoa_id !== null && dados.pessoa_id !== "" && Number(dados.pessoa_id) !== escopo.pessoaId) {
      throw erro("Você só pode atribuir o contato a você mesmo.");
    }
  }
  // linha_origem é NOT NULL e faz parte da chave natural: linhas manuais usam
  // sequência NEGATIVA por (uf, setor) — nunca colidem com as da planilha (positivas)
  const proxima = db.prepare("SELECT COALESCE(MIN(linha_origem), 0) m FROM contatos_ativo WHERE uf = ? AND setor = ? AND linha_origem < 0").get(uf, setor).m;
  const base = { uf, setor, linha_origem: Math.min(proxima, 0) - 1, orgao: orgaoDaAba(setor), origem: "manual" };
  const linhaFalsa = { uf };
  for (const campo of ["responsavel", "cargo", "email", "observacoes", "curso", "telefone", "whatsapp", "data_ultimo_contato", "cor_linha", "pessoa_id", "contato_inexistente", "cadastro_crm"]) {
    if (dados[campo] !== undefined) Object.assign(base, EDITAVEIS[campo](dados[campo], linhaFalsa));
  }
  if (dados.codigo_ibge) Object.assign(base, EDITAVEIS.codigo_ibge(dados.codigo_ibge, linhaFalsa));
  else if (texto(dados.municipio_texto)) base.municipio_texto = texto(dados.municipio_texto, 200);
  if (!base.municipio_texto && !base.responsavel && !base.telefone) throw erro("Informe ao menos município, responsável ou telefone.");
  const agora = new Date().toISOString();
  base.criado_em = agora; base.editado_em = agora; base.editado_por = usuarioId; base.contato_inexistente = base.contato_inexistente ?? 0;
  const id = db.transaction(() => {
    const colunas = Object.keys(base);
    const info = db.prepare(`INSERT INTO contatos_ativo (${colunas.join(", ")}) VALUES (${colunas.map((c) => "@" + c).join(", ")})`).run(base);
    inserirHistorico.run({ contato_id: info.lastInsertRowid, tipo: "criacao", canal: null, campo: null, valor_anterior: null,
      valor_novo: null, observacao: "criado na tela de trabalho", usuario_id: usuarioId, registrado_em: agora });
    return info.lastInsertRowid;
  })();
  if (!base.codigo_ibge && base.municipio_texto) cruzarMunicipios(); // casa o texto livre como na importação
  if (base.telefone || base.whatsapp) cdr.cruzarLigacoes({ numeros: [base.telefone, base.whatsapp].filter(Boolean) });
  return linhaCompactaDe(id, escopo);
}

// Fase 4: ligações do CDR para o número do contato e para o município dele
// (só leitura; linha fora do escopo = 404 como em buscarLinha)
function ligacoesDoContato(id, escopo = null) {
  const linha = buscarLinha(id, escopo);
  return cdr.ligacoesDoContato(linha, escopo);
}

function criarStatus({ nome, corHex, significado }, usuarioId) {
  const n = texto(nome, 60);
  const hex = String(corHex || "").replace(/^#/, "").toUpperCase();
  if (!n) throw erro("Informe o nome do status.");
  if (!/^[0-9A-F]{6}$/.test(hex)) throw erro("Cor inválida — use 6 hex (ex.: 2AB5C2).");
  if (db.prepare("SELECT 1 FROM cores_prospeccao WHERE cor_hex = ?").get(hex)) throw erro("Já existe uma cor com esse hex — nomeie-a na lista em vez de criar outra.");
  if (db.prepare("SELECT 1 FROM cores_prospeccao WHERE lower(status_nome) = lower(?)").get(n)) throw erro("Já existe um status com esse nome.");
  db.prepare(
    `INSERT INTO cores_prospeccao (cor_hex, origem, status_nome, significado, ignorar, atualizado_em, usuario_id)
     VALUES (?, 'criado', ?, ?, 0, ?, ?)`
  ).run(hex, n, texto(significado, 300), new Date().toISOString(), usuarioId);
  return listarCores().find((c) => c.hex === hex);
}

// Exportação .xlsx: uma aba por setor (como o original), linha pintada com a cor do status
async function exportarXlsx(uf, ids, escopo = null) {
  uf = String(uf || "").toUpperCase();
  if (!UFS_ACEITAS.includes(uf)) throw erro("UF inválida.");
  const cm = clausulaMunicipios(escopo); // vendedor: ids ∩ escopo, ou a carteira dele
  let linhas;
  if (Array.isArray(ids) && ids.length) {
    const numeros = ids.map(Number).filter(Number.isInteger);
    linhas = [];
    for (let i = 0; i < numeros.length; i += 900) {
      const lote = numeros.slice(i, i + 900);
      linhas.push(...db.prepare(`SELECT * FROM contatos_ativo WHERE uf = ? AND ${cm.sql} AND id IN (${lote.map(() => "?").join(",")})`).all(uf, ...cm.valores, ...lote));
    }
    linhas.sort((a, b) => a.setor.localeCompare(b.setor) || (a.linha_origem ?? 1e9) - (b.linha_origem ?? 1e9) || a.id - b.id);
  } else {
    linhas = db.prepare(`SELECT * FROM contatos_ativo WHERE uf = ? AND ${cm.sql} ORDER BY setor, linha_origem, id`).all(uf, ...cm.valores);
  }
  const status = new Map(db.prepare("SELECT cor_hex, status_nome, ignorar FROM cores_prospeccao").all().map((c) => [c.cor_hex, c]));
  const municipios = new Map(db.prepare("SELECT m.codigo_ibge c, m.nome, r.sigla FROM municipios m LEFT JOIN regionais r ON r.id = m.regional_principal_id").all().map((m) => [m.c, m]));
  const consultores = new Map(consultoresAtuais().map((c) => [c.id, c.nome]));
  const wb = new ExcelJS.Workbook();
  wb.creator = "jonIAs";
  const cabecalho = ["Município", "Regional", "Órgão", "Responsável", "Cargo", "Telefone", "WhatsApp", "E-mail", "Último contato",
    "Status", "Consultor", "Curso", "Observações", "Contato inexistente", "Cadastro CRM", "Oculta na planilha", "Consultor (planilha)", "ID jonIAs"];
  const nomesUsados = new Set();
  const nomeAba = (setor) => {
    let base = String(setor).replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 28) || "Setor";
    let nome = base, n = 2;
    while (nomesUsados.has(nome.toLowerCase())) nome = `${base} ${n++}`;
    nomesUsados.add(nome.toLowerCase());
    return nome;
  };
  let ws = null, setorAtual = null;
  for (const l of linhas) {
    if (l.setor !== setorAtual) {
      setorAtual = l.setor;
      ws = wb.addWorksheet(nomeAba(l.setor));
      ws.addRow(cabecalho).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.columns = cabecalho.map((h, i) => ({ width: [24, 12, 8, 26, 18, 18, 18, 30, 14, 20, 12, 28, 40, 14, 10, 8, 14, 10][i] || 14 }));
    }
    const m = l.codigo_ibge ? municipios.get(l.codigo_ibge) : null;
    const st = l.cor_linha ? status.get(l.cor_linha) : null;
    const statusTexto = l.contato_inexistente ? "Contato inexistente" : st?.status_nome || "";
    const row = ws.addRow([
      m?.nome || l.municipio_texto || "", m?.sigla || "", l.orgao || "", l.responsavel || "", l.cargo || "",
      l.telefone_original || "", l.whatsapp_original || "", l.email || "", l.data_ultimo_contato || "",
      statusTexto, l.pessoa_id ? consultores.get(l.pessoa_id) || "" : "", l.curso || "", l.observacoes || "",
      l.contato_inexistente ? "Sim" : "", l.cadastro_crm === 1 ? "Sim" : l.cadastro_crm === 0 ? "Não" : "",
      l.linha_oculta ? "Sim" : "", l.consultor_planilha || "", l.id,
    ]);
    if (l.cor_linha && !(st?.ignorar)) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + l.cor_linha } };
    }
  }
  if (!ws) wb.addWorksheet("Vazio").addRow(["Nenhum contato no filtro"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ======================================================================
// Fase 3 — papel vendedor: lista enxuta de status, carteiras por regional
// (titular + apoios) e drill down gerencial do admin
// ======================================================================

// Para o vendedor: só o que a tela de trabalho precisa (hex, nome, significado)
function listarCoresEnxuto() {
  return db.prepare(
    `SELECT cor_hex hex, status_nome statusNome, significado, origem, ignorar FROM cores_prospeccao
     WHERE status_nome IS NOT NULL AND ignorar = 0 ORDER BY ordem, linhas DESC`
  ).all().map((c) => ({ ...c, ignorar: false }));
}

function listarCarteiras() {
  const regionais = db.prepare(
    `SELECT r.id, r.uf, r.sigla, r.nome,
            (SELECT COUNT(*) FROM contatos_ativo c JOIN municipios m ON m.codigo_ibge = c.codigo_ibge WHERE m.regional_principal_id = r.id) contatos,
            (SELECT COUNT(*) FROM contatos_ativo c JOIN municipios m ON m.codigo_ibge = c.codigo_ibge WHERE m.regional_principal_id = r.id AND c.pessoa_id IS NULL) semConsultor
     FROM regionais r ORDER BY r.uf, r.sigla`
  ).all();
  const vinculos = db.prepare(
    `SELECT ca.regional_id regionalId, ca.pessoa_id pessoaId, ca.papel, p.nome FROM carteiras ca JOIN pessoas p ON p.id = ca.pessoa_id ORDER BY ca.papel, p.nome`
  ).all();
  for (const r of regionais) {
    r.titular = vinculos.find((v) => v.regionalId === r.id && v.papel === "titular") || null;
    r.apoios = vinculos.filter((v) => v.regionalId === r.id && v.papel === "apoio");
  }
  // Pessoas elegíveis: consultores ligados a um usuário vendedor ativo, mais a equipe atual
  const pessoas = db.prepare(
    `SELECT DISTINCT p.id, p.nome, (u.id IS NOT NULL) temUsuario FROM pessoas p
     LEFT JOIN usuarios u ON u.pessoa_id = p.id AND u.papel = 'vendedor' AND u.ativo = 1
     WHERE p.tipo = 'consultor' AND (u.id IS NOT NULL OR p.nome IN (${CONSULTORES_ATUAIS.map(() => "?").join(",")}))
     ORDER BY p.nome`
  ).all(...CONSULTORES_ATUAIS);
  return { regionais, pessoas };
}

// Grava titular + apoios de uma regional. Ao definir/trocar o titular, os
// contatos SEM consultor da regional passam para ele (decisão do usuário) —
// com uma linha de histórico por contato; nada que já tinha dono muda.
function gravarCarteira(regionalId, { titularPessoaId, apoios }, usuarioId) {
  const regional = db.prepare("SELECT id, sigla FROM regionais WHERE id = ?").get(Number(regionalId));
  if (!regional) throw erro("Regional inexistente.");
  const titular = titularPessoaId === null || titularPessoaId === undefined || titularPessoaId === "" ? null : Number(titularPessoaId);
  const listaApoios = [...new Set((Array.isArray(apoios) ? apoios : []).map(Number).filter((n) => Number.isInteger(n) && n !== titular))];
  for (const id of [titular, ...listaApoios].filter((x) => x !== null)) {
    if (!db.prepare("SELECT 1 FROM pessoas WHERE id = ? AND tipo = 'consultor'").get(id)) throw erro(`Pessoa ${id} não é um consultor.`);
  }
  const agora = new Date().toISOString();
  let atribuidos = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM carteiras WHERE regional_id = ?").run(regional.id);
    const inserir = db.prepare("INSERT INTO carteiras (regional_id, pessoa_id, papel, criado_em, usuario_id) VALUES (?, ?, ?, ?, ?)");
    if (titular !== null) inserir.run(regional.id, titular, "titular", agora, usuarioId);
    for (const id of listaApoios) inserir.run(regional.id, id, "apoio", agora, usuarioId);
    if (titular !== null) {
      const semDono = db.prepare(
        `SELECT c.id FROM contatos_ativo c JOIN municipios m ON m.codigo_ibge = c.codigo_ibge
         WHERE m.regional_principal_id = ? AND c.pessoa_id IS NULL`
      ).all(regional.id);
      // Atribuição em massa NÃO marca editado_em: não é edição de conteúdo, e
      // marcar bloquearia a reimportação de todas as abas da UF
      const atualizar = db.prepare("UPDATE contatos_ativo SET pessoa_id = ?, atualizado_em = ? WHERE id = ?");
      for (const { id } of semDono) {
        atualizar.run(titular, agora, id);
        inserirHistorico.run({ contato_id: id, tipo: "edicao", canal: null, campo: "pessoa_id", valor_anterior: null,
          valor_novo: String(titular), observacao: `atribuído pela carteira da regional ${regional.sigla}`, usuario_id: usuarioId, registrado_em: agora });
        atribuidos++;
      }
    }
  })();
  return { atribuidos, carteiras: listarCarteiras() };
}

// Drill down gerencial (admin): por regional, quem é responsável, quantos
// contatos existem, quantos foram trabalhados, quantos nunca foram tocados e
// a data do último contato. "Trabalhado" = tem data de último contato ou
// registro de contato no histórico.
function gerencial() {
  const regionais = db.prepare(
    `SELECT r.id, r.uf, r.sigla, r.nome,
            COUNT(c.id) contatos,
            SUM(c.linha_oculta = 0) visiveis,
            SUM(c.telefone_valido = 1) telefonesValidos,
            SUM(c.pessoa_id IS NULL) semConsultor,
            SUM(c.data_ultimo_contato IS NOT NULL OR EXISTS (SELECT 1 FROM contatos_ativo_historico h WHERE h.contato_id = c.id AND h.tipo = 'contato')) trabalhados,
            SUM(c.data_ultimo_contato IS NULL AND NOT EXISTS (SELECT 1 FROM contatos_ativo_historico h WHERE h.contato_id = c.id AND h.tipo = 'contato')) nuncaTocados,
            SUM(c.contato_inexistente = 1) inexistentes,
            MAX(c.data_ultimo_contato) ultimoContato,
            SUM(c.editado_em IS NOT NULL) editados
     FROM regionais r
     LEFT JOIN municipios m ON m.regional_principal_id = r.id
     LEFT JOIN contatos_ativo c ON c.codigo_ibge = m.codigo_ibge
     GROUP BY r.id ORDER BY r.uf, r.sigla`
  ).all();
  const vinculos = db.prepare(
    `SELECT ca.regional_id regionalId, ca.papel, p.nome FROM carteiras ca JOIN pessoas p ON p.id = ca.pessoa_id ORDER BY ca.papel, p.nome`
  ).all();
  for (const r of regionais) {
    r.titular = vinculos.find((v) => v.regionalId === r.id && v.papel === "titular")?.nome || null;
    r.apoios = vinculos.filter((v) => v.regionalId === r.id && v.papel === "apoio").map((v) => v.nome);
  }
  const semRegional = db.prepare(
    `SELECT uf, COUNT(*) contatos, SUM(pessoa_id IS NULL) semConsultor FROM contatos_ativo
     WHERE codigo_ibge IS NULL OR codigo_ibge NOT IN (SELECT codigo_ibge FROM municipios WHERE regional_principal_id IS NOT NULL)
     GROUP BY uf`
  ).all();
  const porUf = db.prepare(
    `SELECT uf, COUNT(*) contatos, SUM(pessoa_id IS NULL) semConsultor,
            SUM(data_ultimo_contato IS NULL AND NOT EXISTS (SELECT 1 FROM contatos_ativo_historico h WHERE h.contato_id = contatos_ativo.id AND h.tipo = 'contato')) nuncaTocados
     FROM contatos_ativo GROUP BY uf`
  ).all();
  return { regionais, semRegional, porUf, geradoEm: new Date().toISOString() };
}

module.exports = {
  importarProspeccao,
  coberturaProspeccao,
  listarCores,
  definirStatusCor,
  // Fase 3
  listarCoresEnxuto,
  listarCarteiras,
  gravarCarteira,
  gerencial,
  // Fase 2
  payloadTrabalho,
  atualizarContato,
  registrarContato,
  historicoDoContato,
  ligacoesDoContato,
  criarContato,
  criarStatus,
  marcarContato,
  marcacoesDeOutro,
  exportarXlsx,
  CONSULTORES_ATUAIS,
  // utilitários (testes)
  normalizarTelefoneOriginal,
  aplicarTint,
  campoDoRotulo,
  orgaoDaAba,
  UFS_ACEITAS,
};
