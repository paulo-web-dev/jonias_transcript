"use strict";

// FERIADOS (migração 33; decisão do usuário, 2026-10-27). Dia útil = seg–sex
// que não está na tabela `feriados`. Vale para TUDO que conta dias úteis: a
// geração da Rota (não há rota em feriado), os denominadores de meta do motor
// (`diasUteis` em metricas.js), a meta fechada da semana na TV (metaDia × dias
// úteis da semana, não mais × 5) e o "dia N de M".
// - Editável no painel da Rota (admin). Só data de HOJE em diante: feriado
//   passado mudaria o recálculo de relatórios já fechados (decisão do usuário:
//   não cadastrar feriado passado).
// - Cadastrar um feriado descarta as rotas JÁ GERADAS nessa data que ninguém
//   começou (sem baixa) — a de amanhã sai às 17h. Rota com baixa fica, e o
//   retorno avisa.
// - Remover um feriado não gera rota sozinho: o tique de 5 min gera o que for
//   devido (a de hoje; a do próximo dia útil depois das 17h).

const db = require("./db.js");

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const formatoBrasilia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const hojeBrasilia = () => formatoBrasilia.format(new Date());

let cache = null;
const conjunto = () => (cache ??= new Set(db.prepare("SELECT data FROM feriados").all().map((r) => r.data)));

const ehFeriado = (iso) => conjunto().has(iso);
const fimDeSemana = (iso) => { const w = new Date(`${iso}T12:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
const diaUtil = (iso) => !fimDeSemana(iso) && !ehFeriado(iso);

function erro(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

function listar() {
  return db.prepare(
    `SELECT f.data, f.nome, f.criado_em criadoEm, u.nome usuario FROM feriados f LEFT JOIN usuarios u ON u.id = f.usuario_id ORDER BY f.data`
  ).all().map((f) => ({ ...f, fimDeSemana: fimDeSemana(f.data) }));
}

function adicionar({ data, nome }, usuarioId) {
  data = String(data || "");
  nome = String(nome || "").trim().slice(0, 80);
  if (!RE_DATA.test(data) || isNaN(new Date(`${data}T12:00:00Z`))) throw erro("Data inválida — use AAAA-MM-DD.");
  if (!nome) throw erro("Dê um nome ao feriado.");
  if (data < hojeBrasilia()) throw erro("Feriado passado não é cadastrado — mudaria relatórios já fechados.");
  if (ehFeriado(data)) throw erro("Essa data já é feriado.");
  const r = db.transaction(() => {
    db.prepare("INSERT INTO feriados (data, nome, criado_em, usuario_id) VALUES (?, ?, ?, ?)").run(data, nome, new Date().toISOString(), usuarioId);
    const descartadas = db.prepare(
      `DELETE FROM rotas WHERE data = ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(data).changes;
    const comBaixa = db.prepare("SELECT COUNT(*) n FROM rotas WHERE data = ?").get(data).n;
    return { data, nome, descartadas, comBaixa };
  })();
  cache = null;
  console.log(`feriados: ${data} (${nome}) cadastrado — ${r.descartadas} rota(s) descartada(s)` + (r.comBaixa ? `; ${r.comBaixa} com baixa mantida(s)` : ""));
  return r;
}

function remover(data) {
  if (!ehFeriado(data)) throw erro("Feriado não encontrado.", 404);
  if (data < hojeBrasilia()) throw erro("Feriado passado não é removido — mudaria relatórios já fechados.");
  db.prepare("DELETE FROM feriados WHERE data = ?").run(data);
  cache = null;
  console.log(`feriados: ${data} removido`);
  return { data };
}

module.exports = { ehFeriado, diaUtil, listar, adicionar, remover };
