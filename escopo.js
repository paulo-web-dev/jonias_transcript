"use strict";

// Escopo de acesso por papel (Fase 3 da prospecção, 2026-09-09).
//   admin    → escopo null: vê tudo (comportamento anterior).
//   vendedor → vê SÓ as regionais das carteiras dele (titular ou apoio):
//              contatos, métricas próprias, mapa das regionais. O corte é no
//              SERVIDOR, na consulta SQL — o payload nunca carrega dado de outra
//              pessoa, nem escondido (mesmo rigor da TV).
//   vendedor com campanha PRÓPRIA da Rota vigente (Rota por setor, migração
//              34, decisão do usuário 2026-10-27): na PROSPECÇÃO (aba
//              Trabalho, Rota, edição, exportação) vê os SETORES (abas) da fila
//              dele em todo o PR e SC, sem recorte de regional. Território, Meu
//              painel e o painel do CDR continuam pela carteira regional.
// Este módulo só calcula e valida; as consultas que o usam recebem `escopo`.

const db = require("./db.js");

const PAPEIS = ["admin", "vendedor"];

// Rotas liberadas enquanto a senha temporária não foi trocada
const LIVRES_COM_SENHA_TEMPORARIA = ["/trocar-senha", "/api/senha", "/api/sessao", "/api/logout", "/login"];

const formatoBrasilia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

// Setores {uf, setor} da campanha PRÓPRIA da Rota vigente hoje (todos os tipos
// da fila do vendedor: principal + complemento). null = sem campanha própria
// (ou encerrada): a prospecção segue pela carteira regional.
function setoresDoVendedor(pessoaId) {
  if (!pessoaId) return null;
  const c = db.prepare(
    "SELECT fila_json FROM rota_campanhas WHERE pessoa_id = ? AND vale_desde <= ? ORDER BY vale_desde DESC, id DESC LIMIT 1"
  ).get(pessoaId, formatoBrasilia.format(new Date()));
  const ids = c ? JSON.parse(c.fila_json || "[]") : [];
  if (!ids.length) return null;
  const vistos = new Map();
  for (const t of db.prepare(`SELECT setores_json FROM rota_tipos WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)) {
    for (const x of JSON.parse(t.setores_json)) vistos.set(`${x.uf}|${x.setor}`, { uf: x.uf, setor: x.setor });
  }
  return vistos.size ? [...vistos.values()] : null;
}

// { pessoaId, regionais: [ids], ufs: [...], municipios: Set(códigos), vazio: bool,
//   setores: [{uf, setor}] | null, setorChaves: Set("UF|setor") | null } ou null (admin)
function escopoDe(usuario) {
  if (!usuario || usuario.papel === "admin") return null;
  const regionais = usuario.pessoa_id
    ? db.prepare("SELECT regional_id id FROM carteiras WHERE pessoa_id = ? ORDER BY regional_id").all(usuario.pessoa_id).map((r) => r.id)
    : [];
  const municipios = new Set();
  const ufs = new Set();
  if (regionais.length) {
    const marcadores = regionais.map(() => "?").join(",");
    for (const m of db.prepare(`SELECT codigo_ibge c, uf FROM municipios WHERE regional_principal_id IN (${marcadores})`).all(...regionais)) {
      municipios.add(m.c);
      ufs.add(m.uf);
    }
  }
  const setores = setoresDoVendedor(usuario.pessoa_id);
  return {
    pessoaId: usuario.pessoa_id ?? null, regionais, ufs: [...ufs].sort(), municipios, vazio: municipios.size === 0,
    setores, setorChaves: setores ? new Set(setores.map((x) => `${x.uf}|${x.setor}`)) : null,
  };
}

// ---------- corte dos CONTATOS da prospecção ----------
// Por setor (campanha própria) ou por município da carteira. `p` = prefixo da
// tabela contatos_ativo na consulta ("c." etc.).
function clausulaContatos(escopo, p = "") {
  if (!escopo) return { sql: "1=1", valores: [] };
  if (escopo.setores) {
    return { sql: `(${p}uf, ${p}setor) IN (VALUES ${escopo.setores.map(() => "(?, ?)").join(", ")})`, valores: escopo.setores.flatMap((x) => [x.uf, x.setor]) };
  }
  return clausulaMunicipios(escopo, `${p}codigo_ibge`);
}
const contatoNoEscopo = (escopo, linha) =>
  !escopo || (escopo.setores ? escopo.setorChaves.has(`${linha.uf}|${linha.setor}`) : dentroDoEscopo(escopo, linha.codigo_ibge));
// Município que o vendedor pode pôr num contato: por setor, qualquer um da UF do
// contato; pela carteira, só os da regional
function municipioPermitido(escopo, codigoIbge, uf) {
  if (!escopo) return true;
  if (escopo.setores) return !!db.prepare("SELECT 1 FROM municipios WHERE codigo_ibge = ? AND uf = ?").get(Number(codigoIbge), uf);
  return dentroDoEscopo(escopo, codigoIbge);
}
// Cláusula dos municípios das LISTAS auxiliares (filtros da tela)
const clausulaMunicipiosLista = (escopo, coluna = "codigo_ibge") =>
  escopo?.setores ? { sql: "1=1", valores: [] } : clausulaMunicipios(escopo, coluna);
// O que a tela da prospecção recebe do escopo
function resumoProspeccao(escopo) {
  if (!escopo) return null;
  if (!escopo.setores) return { regionais: escopo.regionais, ufs: escopo.ufs, vazio: escopo.vazio, setores: null };
  return { regionais: escopo.regionais, ufs: [...new Set(escopo.setores.map((x) => x.uf))].sort(), vazio: false, setores: escopo.setores };
}

// Cláusula SQL "codigo_ibge IN (...)" para um escopo (ou "1=1" para admin).
// Devolve { sql, valores } prontos para concatenar em WHERE.
function clausulaMunicipios(escopo, coluna = "codigo_ibge") {
  if (!escopo) return { sql: "1=1", valores: [] };
  if (escopo.vazio) return { sql: "0=1", valores: [] };
  const codigos = [...escopo.municipios];
  return { sql: `${coluna} IN (${codigos.map(() => "?").join(",")})`, valores: codigos };
}

const dentroDoEscopo = (escopo, codigoIbge) => !escopo || (codigoIbge !== null && escopo.municipios.has(Number(codigoIbge)));

// Middlewares
function exigirAdmin(req, res, next) {
  if (req.usuario?.papel === "admin") return next();
  if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
    return res.status(403).json({ error: "Acesso restrito ao administrador." });
  }
  res.status(403).send(paginaProibida());
}

// Usuário com senha temporária só passa por trocar-senha/logout/sessão
function exigirSenhaTrocada(req, res, next) {
  const u = req.usuario;
  if (!u || !u.senha_temporaria) return next();
  const caminho = req.originalUrl.split("?")[0];
  if (LIVRES_COM_SENHA_TEMPORARIA.some((p) => caminho === p || caminho.startsWith(p + "/"))) return next();
  if (caminho.startsWith("/api/")) return res.status(403).json({ error: "Troque a senha inicial antes de continuar.", trocarSenha: true });
  res.redirect("/trocar-senha");
}

function paginaProibida() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Acesso restrito — jonIAs</title>
<link rel="stylesheet" href="/css/style.css"></head><body class="pagina-login"><main class="login-caixa">
<h1>jon<span class="grad">IA</span>s</h1><p class="login-subtitulo">Esta tela é só do administrador.</p>
<a class="btn btn-primario btn-largo" href="/prospeccao">Voltar para a minha carteira</a></main></body></html>`;
}

const paginaInicialDe = (usuario) => (usuario.papel === "vendedor" ? "/prospeccao" : "/aulas");

module.exports = {
  PAPEIS, escopoDe, clausulaMunicipios, dentroDoEscopo, exigirAdmin, exigirSenhaTrocada, paginaInicialDe,
  clausulaContatos, contatoNoEscopo, municipioPermitido, clausulaMunicipiosLista, resumoProspeccao,
};
