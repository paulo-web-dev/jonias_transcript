"use strict";

// PLANNER DE CONTEÚDO (migração 41; decisões do usuário, 2026-11-12). Migra o
// artifact "Funil de Conteúdo Unyflex" para o jonIAs. Zero IA.
//
// O plano continua nascendo nas planilhas (.xlsx "Planner_Conteudo_…" /
// "planner-…"), importadas aqui (só admin). O que é NOVO em relação ao artifact:
// - LINK OBRIGATÓRIO (http/https) ao marcar publicado e no feito extra;
// - CARIMBO de quando cada estado foi marcado; o ATRASO é a métrica principal:
//   dia do carimbo de publicado − data do post, em dias corridos;
// - a data do post (referência do atraso) NUNCA muda por reimportação: só o
//   ADMIN replaneja, com motivo, registrado em planner_replanejamentos;
// - "não vai sair" com motivo obrigatório: sai das pendências e conta como
//   NÃO FEITO no indicador;
// - o atraso é de QUEM PUBLICA (coluna "Dono": "Kesley publica · Gustavo
//   aprova" → Kesley; "Gustavo publica (…)" → Gustavo; "Gustavo (design) ·
//   Kesley publica" → Kesley, opção (a) do usuário);
// - post ligado a 0, 1 ou várias TURMAS do banco, ou a um tipo explícito
//   (institucional | setor | livre); o que não casa fica "pendente" para o
//   admin ligar à mão (a decisão vale por texto e é reaplicada a cada import);
// - RETROATIVO: post com data anterior a `marketing_planner_desde` fica fora
//   do indicador (mesma regra do e-mail); os 12 status de novembro vindos do
//   artifact entram como "migrado", sem carimbo.
// - Reimportar: atualiza os campos descritivos; post que sumiu da planilha só
//   sai do plano (`fora_do_plano_em`) se ainda estava planejado e a data é
//   FUTURA — post vencido e pendente continua cobrando (senão apagar da
//   planilha apagaria o atraso).
//
// As planilhas reais têm comentários de célula que fazem o exceljs falhar
// ("reading 'comments'"): a leitura é feita direto do XML com o jszip.

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const db = require("./db.js");

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const formatoBrasilia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const hojeBrasilia = () => formatoBrasilia.format(new Date());
const diaBrasilia = (iso) => formatoBrasilia.format(new Date(iso));
const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
const segundaDe = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return somarDias(d, -((w + 6) % 7)); };

function erro(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}
const lerConfig = (chave) => db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(chave)?.valor ?? null;
const desde = () => lerConfig("marketing_planner_desde") || hojeBrasilia();
const metaConversas = () => Number(lerConfig("marketing_meta_conversas") || 5);

function registrar(acao, ref, detalhe, usuarioId) {
  db.prepare("INSERT INTO marketing_log (area, ref, acao, detalhe, usuario_id, em) VALUES ('planner', ?, ?, ?, ?, ?)")
    .run(ref == null ? null : String(ref), acao, detalhe == null ? null : JSON.stringify(detalhe), usuarioId ?? null, new Date().toISOString());
}

// ---------- normalização (a MESMA do artifact, para as chaves baterem) ----------
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const slugArtifact = (s) => norm(s).replace(/[^\x00-\x7f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
const slugColuna = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ---------- leitura do .xlsx (XML direto) ----------
const desescapar = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const textoXml = (xml) => desescapar([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
const colunaNum = (ref) => [...ref.replace(/\d/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

async function lerPlanilha(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (_) { throw erro("Arquivo ilegível — envie o .xlsx do planner.", 422); }
  const ler = async (p) => (zip.file(p) ? zip.file(p).async("string") : null);
  const wb = await ler("xl/workbook.xml");
  const rels = await ler("xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw erro("Não é um .xlsx válido.", 422);
  const alvos = Object.fromEntries([...rels.matchAll(/<Relationship ([^>]*?)\/?>/g)].map((m) => [(m[1].match(/Id="([^"]*)"/) || [])[1], (m[1].match(/Target="([^"]*)"/) || [])[1]]));
  const abas = [...wb.matchAll(/<sheet [^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map((m) => ({ nome: desescapar(m[1]), rid: m[2] }));
  if (!abas.length) throw erro("A planilha não tem abas.", 422);
  const ss = [...((await ler("xl/sharedStrings.xml")) || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoXml(m[1]));
  // Mesma escolha do artifact: aba que começa com "planner", senão a primeira
  const aba = abas.find((a) => norm(a.nome).startsWith("planner")) || abas[0];
  const alvo = alvos[aba.rid] || "";
  const xml = await ler(alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo.replace(/^\.?\//, "")}`);
  if (!xml) throw erro(`Não consegui ler a aba "${aba.nome}".`, 422);
  const linhas = [];
  for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const linha = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tipo = (c[2].match(/t="(\w+)"/) || [])[1];
      const corpo = c[3] || "";
      let v = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (tipo === "s") v = ss[Number(v)];
      else if (tipo === "inlineStr") v = textoXml(corpo);
      else if (v != null) v = desescapar(v);
      linha[colunaNum(c[1])] = v ?? "";
    }
    linhas.push(Array.from(linha, (x) => (x == null ? "" : String(x))));
  }
  return { aba: aba.nome, linhas };
}

function dataDaCelula(v, anoPadrao) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Math.round(Number(s)) * 864e5).toISOString().slice(0, 10);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) { let a = m[3] ? Number(m[3]) : anoPadrao; if (a < 100) a += 2000; return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Quem PUBLICA, pelo texto do "Dono": o nome que vem antes de "publica"
function responsavelDe(dono) {
  for (const parte of String(dono || "").split(/[·|;]/)) {
    const m = norm(parte).match(/([a-z]+)\s*(?:\([^)]*\)\s*)?(?:propoe e )?publica\b/);
    if (m && ["kesley", "gustavo"].includes(m[1])) return m[1];
  }
  return null;
}

// ---------- vínculo texto → turmas ----------
const PALAVRAS_VAZIAS = new Set(["curso", "cursos", "turma", "turmas", "para", "como", "municipal", "municipais", "municipio", "publico", "publica", "publicos",
  "gestao", "nova", "novo", "sobre", "atualizado", "pratica", "praticas", "completo", "online", "presencial", "evolucao", "fortalecimento", "alunos"]);
const palavras = (s) => new Set(norm(s).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !PALAVRAS_VAZIAS.has(w)));

function turmasPorData() {
  const mapa = new Map();
  for (const t of db.prepare("SELECT id, nome, subtitulo, date(start_date) inicio FROM turmas WHERE start_date IS NOT NULL").all()) {
    if (!mapa.has(t.inicio)) mapa.set(t.inicio, []);
    mapa.get(t.inicio).push({ ...t, palavras: palavras(`${t.nome} ${t.subtitulo || ""}`) });
  }
  return mapa;
}

// Datas citadas no texto ("24/11", "24–27/11", "19–22/01/27"): a de INÍCIO
function datasDoTexto(texto, dataPost) {
  const [anoPost, mesPost] = dataPost.split("-").map(Number);
  const out = [];
  for (const m of String(texto).matchAll(/(\d{1,2})(?:\s*[–-]\s*\d{1,2})?\/(\d{1,2})(?:\/(\d{2,4}))?/g)) {
    const dia = Number(m[1]), mes = Number(m[2]);
    if (!dia || dia > 31 || !mes || mes > 12) continue;
    let ano = m[3] ? Number(m[3]) : anoPost;
    if (ano < 100) ano += 2000;
    if (!m[3] && mes < mesPost - 6) ano += 1; // post de dezembro citando turma de janeiro
    out.push({ data: `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`, inicio: m.index, fim: m.index + m[0].length });
  }
  return out;
}

// Vínculo automático: tipo explícito pelo texto, ou turmas casadas por DATA de
// início + palavra em comum no nome. Toda data citada precisa casar (senão
// pendente — nunca palpite parcial).
function vinculoAutomatico(texto, dataPost, cache) {
  const t = norm(texto).trim();
  if (!t) return { vinculo: "pendente", turmas: [] };
  if (t === "institucional") return { vinculo: "institucional", turmas: [] };
  if (t === "livre") return { vinculo: "livre", turmas: [] };
  const setor = String(texto).trim().match(/^setor\s+(.+)$/i);
  if (setor) return { vinculo: "setor", setor: setor[1].trim(), turmas: [] };
  const datas = datasDoTexto(texto, dataPost);
  if (!datas.length) return { vinculo: "pendente", turmas: [] };
  const ids = new Set();
  let anterior = 0;
  for (const d of datas) {
    // palavras do trecho até esta data (e o texto inteiro como reserva)
    const trecho = palavras(String(texto).slice(anterior, d.inicio));
    const todas = palavras(texto);
    anterior = d.fim;
    const candidatas = cache.get(d.data) || [];
    let achou = candidatas.filter((c) => [...c.palavras].some((w) => trecho.has(w)));
    if (!achou.length) achou = candidatas.filter((c) => [...c.palavras].some((w) => todas.has(w)));
    if (!achou.length) return { vinculo: "pendente", turmas: [] };
    achou.forEach((c) => ids.add(c.id));
  }
  return { vinculo: "turmas", turmas: [...ids] };
}

function aplicarVinculo(postId, texto, dataPost, cache) {
  const manual = db.prepare("SELECT * FROM planner_vinculos_texto WHERE curso_texto = ?").get(texto || "");
  const v = manual
    ? { vinculo: manual.vinculo, setor: manual.setor, turmas: JSON.parse(manual.turmas_json || "[]"), metodo: "manual" }
    : { ...vinculoAutomatico(texto, dataPost, cache), metodo: "auto" };
  db.prepare("DELETE FROM planner_post_turmas WHERE post_id = ?").run(postId);
  const ins = db.prepare("INSERT OR IGNORE INTO planner_post_turmas (post_id, turma_id, metodo) VALUES (?, ?, ?)");
  for (const id of v.turmas) ins.run(postId, id, v.metodo);
  db.prepare("UPDATE planner_posts SET vinculo = ?, setor = ? WHERE id = ?").run(v.vinculo, v.vinculo === "setor" ? v.setor || null : null, postId);
  return v.vinculo;
}

// ---------- importação ----------
function statusMigrados() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "dados", "planner_status_migrados.json"), "utf8")).status || [];
  } catch (_) { return []; }
}

async function importar(buffer, arquivo, usuarioId) {
  const { aba, linhas } = await lerPlanilha(buffer);
  const hi = linhas.findIndex((r) => r.some((c) => slugColuna(c) === "data") && r.some((c) => slugColuna(c) === "canal"));
  if (hi < 0) throw erro(`A aba "${aba}" não tem as colunas data e canal.`, 422);
  const H = linhas[hi].map(slugColuna);
  const col = (r, ...nomes) => { for (const n of nomes) { const i = H.indexOf(n); if (i >= 0) return String(r[i] ?? "").trim(); } return ""; };
  const iData = H.indexOf("data");
  const anoPadrao = Number((String(arquivo).match(/20\d\d/) || ["2026"])[0]);
  const vistos = {};
  const lista = [];
  const ignoradas = [];
  linhas.slice(hi + 1).forEach((r, i) => {
    if (!r.some((c) => String(c).trim())) return;
    const d = dataDaCelula(r[iData], anoPadrao);
    if (!d) { ignoradas.push({ linha: hi + i + 2, motivo: "sem data" }); return; }
    const canal = col(r, "canal");
    const curso = col(r, "curso-turma", "curso", "turma");
    let chave = `${d.replace(/-/g, "")}-${slugArtifact(canal)}-${slugArtifact(curso)}`.slice(0, 120);
    vistos[chave] = (vistos[chave] || 0) + 1;
    if (vistos[chave] > 1) chave += `-${vistos[chave]}`;
    const dono = col(r, "dono");
    lista.push({
      chave, data: d, canal, etapa: col(r, "etapa"), curso, gancho: col(r, "tema-gancho", "tema"), formato: col(r, "formato"),
      pecaMae: col(r, "peca-mae-de-origem", "peca-mae"), dono, responsavel: responsavelDe(dono),
      situacao: col(r, "status"), observacao: col(r, "observacao", "obs"), linha: hi + i + 2,
    });
  });
  if (!lista.length) throw erro("Nenhuma linha com data na planilha.", 422);

  const agora = new Date().toISOString();
  const hoje = hojeBrasilia();
  const cache = turmasPorData();
  const meses = new Set(lista.map((p) => p.data.slice(0, 7)));
  const chaves = new Set(lista.map((p) => p.chave));
  const rel = { arquivo, aba, linhas: lista.length, novos: 0, atualizados: 0, saiuDoPlano: 0, mantidosForaDaPlanilha: [], semResponsavel: [], ignoradas,
    vinculos: {}, migrados: { aplicados: 0, naoCasados: [] }, meses: [...meses].sort() };

  db.transaction(() => {
    const busca = db.prepare("SELECT * FROM planner_posts WHERE chave = ?");
    const ins = db.prepare(`INSERT INTO planner_posts (chave, data_original, data, canal, etapa, curso_texto, gancho, formato, peca_mae, dono_texto, responsavel,
      situacao_planilha, observacao, fonte, criado_em, atualizado_em) VALUES (@chave, @data, @data, @canal, @etapa, @curso, @gancho, @formato, @pecaMae, @dono, @responsavel,
      @situacao, @observacao, @fonte, @agora, @agora)`);
    const upd = db.prepare(`UPDATE planner_posts SET canal = @canal, etapa = @etapa, curso_texto = @curso, gancho = @gancho, formato = @formato, peca_mae = @pecaMae,
      dono_texto = @dono, responsavel = @responsavel, situacao_planilha = @situacao, observacao = @observacao, fonte = @fonte, fora_do_plano_em = NULL,
      atualizado_em = @agora WHERE id = @id`);
    for (const p of lista) {
      const atual = busca.get(p.chave);
      const dados = { ...p, fonte: arquivo, agora };
      let id;
      if (atual) { upd.run({ ...dados, id: atual.id }); id = atual.id; rel.atualizados++; }
      else { id = ins.run(dados).lastInsertRowid; rel.novos++; }
      // o vínculo manual por texto nunca é sobrescrito; o automático é refeito
      const v = aplicarVinculo(id, p.curso, p.data, cache);
      rel.vinculos[v] = (rel.vinculos[v] || 0) + 1;
      if (!p.responsavel) rel.semResponsavel.push({ linha: p.linha, dono: p.dono });
    }
    // Sumiu da planilha (nos meses que o arquivo cobre)
    const marcarFora = db.prepare("UPDATE planner_posts SET fora_do_plano_em = ?, atualizado_em = ? WHERE id = ?");
    for (const p of db.prepare("SELECT id, chave, data, estado FROM planner_posts WHERE fora_do_plano_em IS NULL").all()) {
      if (!meses.has(p.data.slice(0, 7)) || chaves.has(p.chave)) continue;
      if (p.estado === "planejado" && p.data > hoje) { marcarFora.run(agora, agora, p.id); rel.saiuDoPlano++; }
      else rel.mantidosForaDaPlanilha.push({ chave: p.chave, data: p.data, estado: p.estado });
    }
    // Status vindos do artifact (sem carimbo): só em post ainda planejado e nunca migrado
    const mig = db.prepare("UPDATE planner_posts SET estado = ?, migrado = 1, atualizado_em = ? WHERE chave = ? AND estado = 'planejado' AND migrado = 0 AND produzido_em IS NULL AND publicado_em IS NULL");
    for (const s of statusMigrados()) {
      if (!meses.has(`${s.chave.slice(0, 4)}-${s.chave.slice(4, 6)}`)) continue;
      if (!["produzido", "publicado"].includes(s.estado)) continue;
      const n = mig.run(s.estado, agora, s.chave).changes;
      if (n) rel.migrados.aplicados++;
      else if (!db.prepare("SELECT 1 FROM planner_posts WHERE chave = ? AND migrado = 1").get(s.chave)) rel.migrados.naoCasados.push(s);
    }
    registrar("importacao", arquivo, { aba: rel.aba, linhas: rel.linhas, novos: rel.novos, atualizados: rel.atualizados, saiuDoPlano: rel.saiuDoPlano, migrados: rel.migrados.aplicados }, usuarioId);
  })();
  rel.pendentesVinculo = db.prepare("SELECT COUNT(*) n FROM planner_posts WHERE vinculo = 'pendente' AND fora_do_plano_em IS NULL").get().n;
  console.log(`planner: ${arquivo} — ${rel.linhas} post(s): ${rel.novos} novo(s), ${rel.atualizados} atualizado(s), ${rel.saiuDoPlano} fora do plano, ` +
    `${rel.migrados.aplicados} status migrado(s), ${rel.pendentesVinculo} pendente(s) de vínculo.`);
  return rel;
}

// ---------- leitura e situação ----------
const SQL_POSTS = `
  SELECT p.*, u1.nome produzido_por_nome, u2.nome publicado_por_nome, u3.nome nao_sai_por_nome
    FROM planner_posts p LEFT JOIN usuarios u1 ON u1.id = p.produzido_por LEFT JOIN usuarios u2 ON u2.id = p.publicado_por
    LEFT JOIN usuarios u3 ON u3.id = p.nao_sai_por`;

function classificar(p, hoje, inicio, turmas) {
  const retroativo = p.data < inicio;
  let situacao, atrasoDias = null, venceEmDias = null;
  if (p.estado === "publicado") {
    situacao = "publicado";
    if (p.publicado_em) atrasoDias = Math.max(0, diasEntre(p.data, diaBrasilia(p.publicado_em)));
  } else if (p.estado === "nao_vai_sair") {
    situacao = "nao_vai_sair";
  } else {
    const d = diasEntre(p.data, hoje);
    situacao = d > 0 ? "atrasado" : d === 0 ? "hoje" : "no_prazo";
    if (d > 0) atrasoDias = d; else venceEmDias = -d;
  }
  return {
    id: p.id, chave: p.chave, data: p.data, dataOriginal: p.data_original, canal: p.canal, etapa: p.etapa, cursoTexto: p.curso_texto,
    gancho: p.gancho, formato: p.formato, pecaMae: p.peca_mae, dono: p.dono_texto, responsavel: p.responsavel, situacaoPlanilha: p.situacao_planilha,
    observacao: p.observacao, vinculo: p.vinculo, setor: p.setor, turmas: turmas.get(p.id) || [],
    estado: p.estado, produzidoEm: p.produzido_em, produzidoPor: p.produzido_por_nome, publicadoEm: p.publicado_em, publicadoPor: p.publicado_por_nome,
    link: p.link, alcance: p.alcance, engajamento: p.engajamento, conversas: p.conversas, motivo: p.motivo, proxima: p.proxima,
    naoSaiMotivo: p.nao_sai_motivo, naoSaiEm: p.nao_sai_em, naoSaiPor: p.nao_sai_por_nome,
    migrado: !!p.migrado, foraDoPlano: p.fora_do_plano_em, fonte: p.fonte,
    retroativo, situacao, atrasoDias, venceEmDias,
  };
}

function turmasDosPosts() {
  const mapa = new Map();
  for (const r of db.prepare(
    `SELECT pt.post_id, t.id, t.nome, date(t.start_date) inicio, pt.metodo FROM planner_post_turmas pt JOIN turmas t ON t.id = pt.turma_id ORDER BY t.start_date`
  ).all()) {
    if (!mapa.has(r.post_id)) mapa.set(r.post_id, []);
    mapa.get(r.post_id).push({ id: r.id, nome: (r.nome || "").trim(), inicio: r.inicio, metodo: r.metodo });
  }
  return mapa;
}

function listarPosts() {
  const hoje = hojeBrasilia(), inicio = desde(), turmas = turmasDosPosts();
  return db.prepare(`${SQL_POSTS} ORDER BY p.data, p.id`).all().map((p) => classificar(p, hoje, inicio, turmas));
}

// INDICADOR de quem publica num período [de, ate]: posts do plano (sem os
// retroativos e os que saíram do plano) DEVIDOS: data já passou, ou é hoje e
// já foi resolvido (publicado / não vai sair). O post de hoje ainda pendente
// não reprova antes de o dia acabar (mesma regra do pipeline) — aparece em
// `pendentes`. % no prazo = publicados com atraso 0 ÷ devidos. Atraso médio =
// média dos dias de atraso: publicado → atraso do carimbo; pendente vencido →
// dias até hoje (ainda crescendo). "Não vai sair" conta como não feito e fica
// fora da média. Migrado sem carimbo é sempre retroativo.
function indicador(posts, responsavel, de, ate) {
  const hoje = hojeBrasilia();
  const doPeriodo = posts.filter((p) => p.responsavel === responsavel && !p.retroativo && !p.foraDoPlano && p.data >= de && p.data <= ate);
  const devidos = doPeriodo.filter((p) => p.data < hoje || (p.data === hoje && (p.situacao === "publicado" || p.situacao === "nao_vai_sair")));
  const publicados = devidos.filter((p) => p.situacao === "publicado");
  const noPrazo = publicados.filter((p) => p.atrasoDias === 0);
  const pendentes = doPeriodo.filter((p) => p.data <= hoje && (p.situacao === "atrasado" || p.situacao === "hoje"));
  const atrasados = devidos.filter((p) => p.situacao === "atrasado");
  const comAtraso = [...publicados, ...atrasados].filter((p) => p.atrasoDias != null);
  return {
    responsavel, de, ate,
    planejados: doPeriodo.length, devidos: devidos.length, publicados: publicados.length,
    noPrazo: noPrazo.length, publicadosComAtraso: publicados.length - noPrazo.length,
    pendentes: pendentes.length, atrasados: atrasados.length, maiorAtraso: atrasados.reduce((m, p) => Math.max(m, p.atrasoDias), 0),
    naoVaiSair: devidos.filter((p) => p.situacao === "nao_vai_sair").length,
    pctNoPrazo: devidos.length ? Math.round((noPrazo.length / devidos.length) * 100) : null,
    atrasoMedio: comAtraso.length ? Math.round((comAtraso.reduce((s, p) => s + p.atrasoDias, 0) / comAtraso.length) * 10) / 10 : null,
  };
}

function listarExtras() {
  return db.prepare(
    `SELECT e.*, u.nome criado_por_nome FROM planner_extras e LEFT JOIN usuarios u ON u.id = e.criado_por ORDER BY e.data DESC, e.id DESC`
  ).all().map((e) => ({ id: e.id, data: e.data, formato: e.formato, canal: e.canal, titulo: e.titulo, link: e.link, alcance: e.alcance,
    engajamento: e.engajamento, conversas: e.conversas, obs: e.obs, criadoEm: e.criado_em, criadoPor: e.criado_por_nome }));
}

function listarRotina() {
  const out = {};
  for (const r of db.prepare("SELECT r.*, u.nome por FROM planner_rotina r LEFT JOIN usuarios u ON u.id = r.feito_por").all()) {
    (out[r.semana] ||= {})[r.item] = { em: r.feito_em, por: r.por };
  }
  return out;
}

function pendentesDeVinculo() {
  return db.prepare(
    `SELECT curso_texto texto, COUNT(*) posts, MIN(data) de, MAX(data) ate FROM planner_posts
      WHERE vinculo = 'pendente' AND fora_do_plano_em IS NULL GROUP BY curso_texto ORDER BY MIN(data)`
  ).all();
}

function payload() {
  const hoje = hojeBrasilia();
  const posts = listarPosts();
  const seg = segundaDe(hoje), domingo = somarDias(seg, 6);
  const mesDe = `${hoje.slice(0, 7)}-01`, mesAte = somarDias(`${somarDias(mesDe, 32).slice(0, 7)}-01`, -1);
  const turmasParaVinculo = db.prepare(
    `SELECT id, nome, subtitulo, date(start_date) inicio FROM turmas WHERE fora_da_origem_em IS NULL AND date(start_date) >= ? ORDER BY date(start_date), nome`
  ).all(somarDias(hoje, -120)).map((t) => ({ id: t.id, nome: (t.nome || "").trim(), subtitulo: (t.subtitulo || "").trim(), inicio: t.inicio }));
  return {
    hoje, desde: desde(), metaConversas: metaConversas(),
    feriados: db.prepare("SELECT data, nome FROM feriados").all(),
    posts, extras: listarExtras(), rotina: listarRotina(),
    vinculos: { pendentes: pendentesDeVinculo(), manuais: db.prepare("SELECT curso_texto texto, vinculo, setor, turmas_json, em FROM planner_vinculos_texto ORDER BY em DESC").all()
      .map((v) => ({ texto: v.texto, vinculo: v.vinculo, setor: v.setor, turmas: JSON.parse(v.turmas_json || "[]"), em: v.em })) },
    turmasParaVinculo,
    indicadores: {
      semana: { kesley: indicador(posts, "kesley", seg, domingo), gustavo: indicador(posts, "gustavo", seg, domingo) },
      mes: { kesley: indicador(posts, "kesley", mesDe, mesAte), gustavo: indicador(posts, "gustavo", mesDe, mesAte) },
    },
    fontes: db.prepare("SELECT fonte, MAX(atualizado_em) em, COUNT(*) n FROM planner_posts WHERE fonte IS NOT NULL GROUP BY fonte ORDER BY fonte").all(),
  };
}

// ---------- ações sobre o post ----------
function buscarPost(id) {
  const p = db.prepare(`${SQL_POSTS} WHERE p.id = ?`).get(Number(id));
  if (!p) throw erro("Post não encontrado.", 404);
  return p;
}
const postClassificado = (id) => classificar(buscarPost(id), hojeBrasilia(), desde(), turmasDosPosts());

function linkValido(link) {
  const s = String(link || "").trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(s)) throw erro("Link obrigatório: cole o endereço do post publicado (começando com http:// ou https://).");
  return s.slice(0, 500);
}
const inteiro = (v) => (v === "" || v == null ? null : Math.max(0, Math.round(Number(v)) || 0));

// planejado → produzido → publicado (publicado exige link). Voltar de
// publicado (ou reabrir "não vai sair") é só do admin: apagaria o carimbo.
function definirEstado(id, { estado, link }, usuario) {
  const p = buscarPost(id);
  const admin = usuario.papel === "admin";
  if (!["planejado", "produzido", "publicado"].includes(estado)) throw erro("Estado inválido.");
  if (p.fora_do_plano_em) throw erro("Esse post saiu do plano.", 409);
  if (p.estado === "nao_vai_sair" && !admin) throw erro("O post está como \"não vai sair\" — só o administrador reabre.", 409);
  if (p.estado === "publicado" && estado !== "publicado" && !admin) throw erro("Só o administrador desfaz um post publicado.", 403);
  if (p.estado === estado) {
    if (estado === "publicado" && link !== undefined) { // ajuste do link
      db.prepare("UPDATE planner_posts SET link = ?, atualizado_em = ? WHERE id = ?").run(linkValido(link), new Date().toISOString(), p.id);
    }
    return postClassificado(p.id);
  }
  const agora = new Date().toISOString();
  const campos = { estado, atualizado_em: agora };
  if (estado === "publicado") {
    campos.link = linkValido(link ?? p.link);
    campos.publicado_em = agora; campos.publicado_por = usuario.id;
  }
  if (estado === "produzido" && !p.produzido_em) { campos.produzido_em = agora; campos.produzido_por = usuario.id; }
  if (estado !== "publicado") { campos.publicado_em = null; campos.publicado_por = null; }
  if (estado === "planejado") { campos.produzido_em = null; campos.produzido_por = null; }
  if (p.estado === "nao_vai_sair") { campos.nao_sai_motivo = null; campos.nao_sai_em = null; campos.nao_sai_por = null; }
  campos.migrado = 0;
  const sets = Object.keys(campos).map((k) => `${k} = @${k}`).join(", ");
  db.transaction(() => {
    db.prepare(`UPDATE planner_posts SET ${sets} WHERE id = @id`).run({ ...campos, id: p.id });
    registrar("estado", p.id, { de: p.estado, para: estado, link: campos.link }, usuario.id);
  })();
  return postClassificado(p.id);
}

// Métricas, link (de publicado) e fechamento de sexta (motivo / próxima ação)
function salvarPost(id, corpo, usuario) {
  const p = buscarPost(id);
  const c = corpo || {};
  const campos = {};
  for (const k of ["alcance", "engajamento", "conversas"]) if (c[k] !== undefined) campos[k] = inteiro(c[k]);
  if (c.motivo !== undefined) campos.motivo = String(c.motivo || "").trim().slice(0, 300) || null;
  if (c.proxima !== undefined) campos.proxima = String(c.proxima || "").trim().slice(0, 300) || null;
  if (c.link !== undefined) {
    if (p.estado !== "publicado") throw erro("O link é registrado ao marcar publicado.");
    campos.link = linkValido(c.link);
  }
  if (!Object.keys(campos).length) return postClassificado(p.id);
  campos.atualizado_em = new Date().toISOString();
  db.prepare(`UPDATE planner_posts SET ${Object.keys(campos).map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...campos, id: p.id });
  registrar("editado", p.id, Object.fromEntries(Object.entries(campos).filter(([k]) => k !== "atualizado_em")), usuario.id);
  return postClassificado(p.id);
}

function naoVaiSair(id, motivo, usuario) {
  const p = buscarPost(id);
  motivo = String(motivo || "").trim().slice(0, 300);
  if (!motivo) throw erro("Diga por que o post não vai sair — o motivo é obrigatório.");
  if (p.estado === "publicado") throw erro("O post já foi publicado.", 409);
  if (p.estado === "nao_vai_sair") throw erro("O post já está como \"não vai sair\".", 409);
  const agora = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE planner_posts SET estado = 'nao_vai_sair', nao_sai_motivo = ?, nao_sai_em = ?, nao_sai_por = ?, atualizado_em = ? WHERE id = ?")
      .run(motivo, agora, usuario.id, agora, p.id);
    registrar("nao_vai_sair", p.id, { motivo, estadoAnterior: p.estado }, usuario.id);
  })();
  return postClassificado(p.id);
}

// Admin: muda a data de referência do atraso, com motivo (registrado)
function replanejar(id, { data, motivo }, usuarioId) {
  const p = buscarPost(id);
  data = String(data || "");
  motivo = String(motivo || "").trim().slice(0, 300);
  if (!RE_DATA.test(data) || isNaN(new Date(`${data}T12:00:00Z`))) throw erro("Data inválida — use AAAA-MM-DD.");
  if (!motivo) throw erro("O motivo do replanejamento é obrigatório.");
  if (data === p.data) throw erro("A data é a mesma.");
  const agora = new Date().toISOString();
  db.transaction(() => {
    db.prepare("INSERT INTO planner_replanejamentos (post_id, de, para, motivo, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.data, data, motivo, usuarioId, agora);
    db.prepare("UPDATE planner_posts SET data = ?, atualizado_em = ? WHERE id = ?").run(data, agora, p.id);
    registrar("replanejado", p.id, { de: p.data, para: data, motivo }, usuarioId);
  })();
  return postClassificado(p.id);
}

function historicoDoPost(id) {
  buscarPost(id);
  return {
    replanejamentos: db.prepare(`SELECT r.de, r.para, r.motivo, r.em, u.nome usuario FROM planner_replanejamentos r LEFT JOIN usuarios u ON u.id = r.usuario_id WHERE r.post_id = ? ORDER BY r.id`).all(Number(id)),
    eventos: db.prepare(`SELECT l.acao, l.detalhe, l.em, u.nome usuario FROM marketing_log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE l.area = 'planner' AND l.ref = ? ORDER BY l.id`).all(String(id))
      .map((e) => ({ ...e, detalhe: e.detalhe ? JSON.parse(e.detalhe) : null })),
  };
}

// ---------- vínculo manual por texto (admin) ----------
const SETORES_LIVRES = 80;
function definirVinculo({ texto, vinculo, setor, turmas }, usuarioId) {
  texto = String(texto ?? "");
  if (!db.prepare("SELECT 1 FROM planner_posts WHERE curso_texto = ?").get(texto)) throw erro("Nenhum post com esse texto de curso/turma.", 404);
  if (!["turmas", "institucional", "setor", "livre"].includes(vinculo)) throw erro("Vínculo inválido.");
  let ids = [];
  if (vinculo === "turmas") {
    ids = [...new Set((turmas || []).map(Number))].filter(Number.isInteger);
    if (!ids.length) throw erro("Escolha ao menos uma turma.");
    const existem = db.prepare(`SELECT COUNT(*) n FROM turmas WHERE id IN (${ids.map(() => "?").join(",")})`).get(...ids).n;
    if (existem !== ids.length) throw erro("Turma inexistente na lista.");
  }
  setor = vinculo === "setor" ? String(setor || "").trim().slice(0, SETORES_LIVRES) : null;
  if (vinculo === "setor" && !setor) throw erro("Diga qual é o setor.");
  const cache = turmasPorData();
  db.transaction(() => {
    db.prepare(`INSERT INTO planner_vinculos_texto (curso_texto, vinculo, setor, turmas_json, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(curso_texto) DO UPDATE SET vinculo = excluded.vinculo, setor = excluded.setor, turmas_json = excluded.turmas_json, usuario_id = excluded.usuario_id, em = excluded.em`)
      .run(texto, vinculo, setor, JSON.stringify(ids), usuarioId, new Date().toISOString());
    for (const p of db.prepare("SELECT id, data FROM planner_posts WHERE curso_texto = ?").all(texto)) aplicarVinculo(p.id, texto, p.data, cache);
    registrar("vinculo", texto, { vinculo, setor, turmas: ids }, usuarioId);
  })();
  return { texto, posts: db.prepare("SELECT COUNT(*) n FROM planner_posts WHERE curso_texto = ?").get(texto).n };
}

// ---------- feito extra (link obrigatório) ----------
function lerExtra(c) {
  const data = String(c.data || "");
  if (!RE_DATA.test(data)) throw erro("Escolha a data.");
  const titulo = String(c.titulo || "").trim().slice(0, 140);
  if (!titulo) throw erro("Descreva o que foi feito.");
  return {
    data, titulo, link: linkValido(c.link),
    formato: String(c.formato || "Outro").trim().slice(0, 60), canal: String(c.canal || "Outro").trim().slice(0, 60),
    alcance: inteiro(c.alcance), engajamento: inteiro(c.engajamento), conversas: inteiro(c.conversas), obs: String(c.obs || "").trim().slice(0, 400) || null,
  };
}
function criarExtra(c, usuarioId) {
  const x = lerExtra(c || {});
  const agora = new Date().toISOString();
  const id = db.prepare(`INSERT INTO planner_extras (data, formato, canal, titulo, link, alcance, engajamento, conversas, obs, criado_em, criado_por, atualizado_em)
    VALUES (@data, @formato, @canal, @titulo, @link, @alcance, @engajamento, @conversas, @obs, @agora, @usuario, @agora)`).run({ ...x, agora, usuario: usuarioId }).lastInsertRowid;
  registrar("extra_criado", id, x, usuarioId);
  return listarExtras().find((e) => e.id === id);
}
function editarExtra(id, c, usuarioId) {
  if (!db.prepare("SELECT 1 FROM planner_extras WHERE id = ?").get(Number(id))) throw erro("Feito extra não encontrado.", 404);
  const x = lerExtra(c || {});
  db.prepare(`UPDATE planner_extras SET data = @data, formato = @formato, canal = @canal, titulo = @titulo, link = @link, alcance = @alcance,
    engajamento = @engajamento, conversas = @conversas, obs = @obs, atualizado_em = @agora WHERE id = @id`).run({ ...x, agora: new Date().toISOString(), id: Number(id) });
  registrar("extra_editado", id, x, usuarioId);
  return listarExtras().find((e) => e.id === Number(id));
}
function excluirExtra(id, usuarioId) {
  const x = db.prepare("SELECT * FROM planner_extras WHERE id = ?").get(Number(id));
  if (!x) throw erro("Feito extra não encontrado.", 404);
  db.prepare("DELETE FROM planner_extras WHERE id = ?").run(x.id);
  registrar("extra_excluido", id, x, usuarioId);
  return { ok: true };
}

// ---------- rotina semanal (checks por item, com carimbo) ----------
function marcarRotina({ semana, item, marcado }, usuarioId) {
  semana = String(semana || "");
  if (!RE_DATA.test(semana) || segundaDe(semana) !== semana) throw erro("Semana inválida (use a segunda-feira, AAAA-MM-DD).");
  if (!/^d[0-4]i\d{1,2}$/.test(String(item || ""))) throw erro("Item inválido.");
  if (marcado) {
    db.prepare("INSERT OR IGNORE INTO planner_rotina (semana, item, feito_em, feito_por) VALUES (?, ?, ?, ?)").run(semana, item, new Date().toISOString(), usuarioId);
  } else {
    db.prepare("DELETE FROM planner_rotina WHERE semana = ? AND item = ?").run(semana, item);
  }
  return listarRotina()[semana] || {};
}

function definirMetaConversas(valor) {
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw erro("Meta inválida.");
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('marketing_meta_conversas', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(String(n));
  return { metaConversas: n };
}

module.exports = {
  importar, payload, listarPosts, indicador, definirEstado, salvarPost, naoVaiSair, replanejar, historicoDoPost,
  definirVinculo, criarExtra, editarExtra, excluirExtra, marcarRotina, definirMetaConversas,
  responsavelDe, vinculoAutomatico, slugArtifact, segundaDe,
};
