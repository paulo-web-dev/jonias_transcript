"use strict";
// Backup automático diário do SQLite (pedido do usuário, 2026-10-06).
//
// - Onde: BACKUP_DIR ou, sem a variável, `backups/` ao lado do banco — em
//   produção /app/data/backups, DENTRO do volume (persiste a deploy).
// - Quando: todo dia depois das 03:00 de Brasília. Timer no Node (a imagem
//   slim não tem cron): no boot e a cada 10 min confere se já existe backup
//   feito depois das 03:00 de hoje; se não, faz. O container pode reiniciar a
//   qualquer momento — a próxima conferência recupera o dia, e um .tmp que
//   ficou pela metade é apagado.
// - Como: checkpoint do WAL → API de backup ONLINE do SQLite (cópia
//   consistente com o app gravando; nunca cópia de arquivo) num .tmp →
//   PRAGMA integrity_check no arquivo gerado → renomeia para o nome final.
//   Cada backup tem um .json ao lado com o resultado (data, tamanho, contatos,
//   user_version, verificação, checkpoint) e uma linha em backups.log. Falha
//   também deixa .json (sem .db) — a tela de Saúde mostra.
// - Retenção: os 7 dias mais recentes (um por dia: o último verificado) + o
//   último verificado de cada uma das 4 semanas anteriores; o resto é
//   apagado sozinho (só arquivos com o padrão de nome daqui).

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const db = require("./db.js");

const HORA = 3;
const DIARIOS = 7;
const SEMANAIS = 4;
const INTERVALO_MS = 10 * 60 * 1000;
const RE_NOME = /^aula-ai-(\d{4}-\d{2}-\d{2})-(\d{4})(?:-manual)?\.(db|json)$/;

const DIR = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(db.name), "backups"));

const formato = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function agoraBrasilia(d = new Date()) {
  const p = Object.fromEntries(formato.formatToParts(d).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), hhmm: `${p.hour}${p.minute}` };
}

const registrar = (linha) => {
  try { fs.appendFileSync(path.join(DIR, "backups.log"), `${new Date().toISOString()} ${linha}\n`); } catch {}
};

// Backups no diretório: um por .json (o .db pode faltar = falha ou apagado à mão)
function listar() {
  if (!fs.existsSync(DIR)) return [];
  const itens = [];
  for (const nome of fs.readdirSync(DIR)) {
    const m = RE_NOME.exec(nome);
    if (!m || m[3] !== "json") continue;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")); } catch { info = { ok: false, erro: "registro .json ilegível" }; }
    const base = nome.slice(0, -5);
    const dbArq = path.join(DIR, `${base}.db`);
    itens.push({ ...info, base, data: m[1], hhmm: m[2], existe: fs.existsSync(dbArq) });
  }
  return itens.sort((a, b) => (b.criadoEm || "").localeCompare(a.criadoEm || "") || b.base.localeCompare(a.base));
}

let emAndamento = null;

// Faz um backup agora. motivo: "agendado" | "manual". Nunca lança: o
// resultado (ok ou falha) vai para o .json, o log e o retorno.
function fazerBackup(motivo = "agendado") {
  if (emAndamento) return emAndamento;
  emAndamento = (async () => {
    const inicio = Date.now();
    const { data, hhmm } = agoraBrasilia();
    const base = `aula-ai-${data}-${hhmm}${motivo === "manual" ? "-manual" : ""}`;
    const tmp = path.join(DIR, `${base}.db.tmp`);
    const final = path.join(DIR, `${base}.db`);
    const info = { arquivo: `${base}.db`, motivo, origem: db.name, criadoEm: new Date().toISOString(), ok: false };
    try {
      fs.mkdirSync(DIR, { recursive: true });
      // 1. checkpoint: passa o -wal para o .db (TRUNCATE zera o -wal). busy=1 não
      //    impede o backup — a API de backup lê o banco consistente com o WAL.
      const [cp] = db.pragma("wal_checkpoint(TRUNCATE)");
      info.checkpoint = cp;
      // 2. backup online (em passos, sem travar o app)
      await db.backup(tmp);
      // o backup herda o modo WAL no cabeçalho; em modo DELETE ele é um arquivo
      // único de verdade (abrir para conferir não cria -wal/-shm ao lado). Ao
      // ser restaurado, o db.js liga o WAL de novo.
      const w = new Database(tmp, { fileMustExist: true });
      w.pragma("journal_mode = DELETE");
      w.close();
      // 3. verificação do ARQUIVO GERADO
      const copia = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        const integridade = copia.pragma("integrity_check").map((r) => r.integrity_check);
        info.integridade = integridade.length === 1 && integridade[0] === "ok" ? "ok" : integridade.slice(0, 10).join(" | ");
        info.userVersion = copia.pragma("user_version", { simple: true });
        const tem = (t) => copia.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
        info.contatos = tem("contatos_ativo") ? copia.prepare("SELECT COUNT(*) FROM contatos_ativo").pluck().get() : null;
        info.usuarios = tem("usuarios") ? copia.prepare("SELECT COUNT(*) FROM usuarios").pluck().get() : null;
      } finally {
        copia.close();
      }
      fs.renameSync(tmp, final);
      info.bytes = fs.statSync(final).size;
      info.ok = info.integridade === "ok";
      if (!info.ok) info.erro = `integrity_check: ${info.integridade}`;
    } catch (e) {
      info.erro = e.message || String(e);
      try { fs.unlinkSync(tmp); } catch {}
    }
    info.duracaoMs = Date.now() - inicio;
    try { fs.writeFileSync(path.join(DIR, `${base}.json`), JSON.stringify(info, null, 2)); } catch (e) { info.erro = `${info.erro || ""} (registro não gravado: ${e.message})`; }
    const linha = info.ok
      ? `OK ${info.arquivo} ${info.bytes} B · ${info.contatos} contato(s) · user_version ${info.userVersion} · integrity_check ok · ${info.duracaoMs} ms (${motivo})`
      : `FALHA ${info.arquivo}: ${info.erro} (${motivo})`;
    registrar(linha);
    (info.ok ? console.log : console.error)(`${info.ok ? "💾" : "✖ "} backup: ${linha}`);
    try { aplicarRetencao(); } catch (e) { registrar(`retenção falhou: ${e.message}`); }
    return info;
  })().finally(() => { emAndamento = null; });
  return emAndamento;
}

// Segunda-feira da semana de uma data AAAA-MM-DD
function inicioSemana(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Quais ficam: por dia, o último verificado (sem nenhum verificado no dia, o
// último registro); os 7 dias mais recentes; e o último verificado de cada uma
// das 4 semanas anteriores à semana do backup diário mais antigo mantido.
function planoRetencao(itens) {
  const porDia = new Map();
  for (const b of itens) {  // itens vêm do mais novo ao mais velho
    const atual = porDia.get(b.data);
    if (!atual || (!atual.ok && b.ok && b.existe)) porDia.set(b.data, b);
  }
  const dias = [...porDia.keys()].sort().reverse();
  const manter = new Set(dias.slice(0, DIARIOS).map((d) => porDia.get(d).base));
  const semanasDiarias = new Set(dias.slice(0, DIARIOS).map(inicioSemana));
  const semanas = [];
  for (const d of dias.slice(DIARIOS)) {
    const b = porDia.get(d);
    if (!b.ok || !b.existe) continue;
    const s = inicioSemana(d);
    if (semanasDiarias.has(s) || semanas.some((x) => x.s === s)) continue;
    if (semanas.length >= SEMANAIS) break;
    semanas.push({ s, base: b.base });
  }
  for (const s of semanas) manter.add(s.base);
  // salvaguarda: o último verificado nunca sai
  const ultimoOk = itens.find((b) => b.ok && b.existe);
  if (ultimoOk) manter.add(ultimoOk.base);
  return { manter, semanais: new Set(semanas.map((s) => s.base)) };
}

function aplicarRetencao() {
  const { manter } = planoRetencao(listar());
  const apagados = [];
  for (const nome of fs.readdirSync(DIR)) {
    const m = RE_NOME.exec(nome);
    if (!m) continue;
    const base = nome.replace(/\.(db|json)$/, "");
    if (manter.has(base)) continue;
    try { fs.unlinkSync(path.join(DIR, nome)); apagados.push(nome); } catch {}
  }
  if (apagados.length) registrar(`retenção: apagado(s) ${apagados.join(", ")}`);
  return apagados;
}

// Tique: depois das 03:00 de Brasília, garante um backup VERIFICADO feito hoje
// depois das 03:00 (agendado ou manual). Antes disso, nada. Falha = nova
// tentativa a cada hora.
function garantirBackup() {
  if (emAndamento) return null;
  // .tmp sem backup em andamento = sobra de um reinício no meio do backup
  if (fs.existsSync(DIR)) {
    for (const nome of fs.readdirSync(DIR)) if (nome.endsWith(".db.tmp")) try { fs.unlinkSync(path.join(DIR, nome)); registrar(`apagado ${nome} (backup interrompido)`); } catch {}
  }
  const { data, hora } = agoraBrasilia();
  if (hora < HORA) return null;
  const hoje = listar().filter((b) => b.data === data && Number(b.hhmm) >= HORA * 100);
  if (hoje.some((b) => b.ok)) return null;
  // falhou hoje: tenta de novo de hora em hora (não a cada tique)
  const ultimaFalha = hoje[0];
  if (ultimaFalha && Date.now() - new Date(ultimaFalha.criadoEm).getTime() < 60 * 60 * 1000) return null;
  return fazerBackup("agendado");
}

function iniciarAgendamento() {
  console.log(`💾 Backup automático: diário após ${String(HORA).padStart(2, "0")}:00 (Brasília) em ${DIR} — ${DIARIOS} diários + ${SEMANAIS} semanais`);
  setTimeout(() => garantirBackup(), 60 * 1000).unref();  // depois do boot, sem atrasar a subida
  setInterval(() => garantirBackup(), INTERVALO_MS).unref();
}

// Para a tela de Saúde
function resumo() {
  const itens = listar();
  const { manter, semanais } = planoRetencao(itens);
  const ultimo = itens[0] || null;
  const ultimoOk = itens.find((b) => b.ok && b.existe) || null;
  const idadeHoras = ultimoOk ? (Date.now() - new Date(ultimoOk.criadoEm).getTime()) / 3600000 : null;
  const enxuto = (b) => b && { arquivo: b.arquivo, criadoEm: b.criadoEm, motivo: b.motivo, ok: !!b.ok, existe: b.existe, bytes: b.bytes ?? null,
    contatos: b.contatos ?? null, userVersion: b.userVersion ?? null, integridade: b.integridade ?? null, erro: b.erro ?? null, duracaoMs: b.duracaoMs ?? null };
  return {
    diretorio: DIR, hora: HORA, retencao: { diarios: DIARIOS, semanais: SEMANAIS }, emAndamento: !!emAndamento,
    ultimo: enxuto(ultimo), ultimoOk: enxuto(ultimoOk), idadeHoras,
    alerta: !ultimoOk ? "nenhum backup verificado" : idadeHoras > 48 ? `último backup verificado há ${Math.floor(idadeHoras)} h` : ultimo && !ultimo.ok ? "o último backup FALHOU" : null,
    backups: itens.filter((b) => manter.has(b.base)).map((b) => ({ ...enxuto(b), tipo: semanais.has(b.base) ? "semanal" : "diário" })),
  };
}

module.exports = { fazerBackup, garantirBackup, iniciarAgendamento, aplicarRetencao, planoRetencao, resumo, listar, DIR };
