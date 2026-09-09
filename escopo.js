"use strict";

// Escopo de acesso por papel (Fase 3 da prospecção, 2026-09-09).
//   admin    → escopo null: vê tudo (comportamento anterior).
//   vendedor → vê SÓ as regionais das carteiras dele (titular ou apoio):
//              contatos, métricas próprias, mapa das regionais. O corte é no
//              SERVIDOR, na consulta SQL — o payload nunca carrega dado de outra
//              pessoa, nem escondido (mesmo rigor da TV).
// Este módulo só calcula e valida; as consultas que o usam recebem `escopo`.

const db = require("./db.js");

const PAPEIS = ["admin", "vendedor"];

// Rotas liberadas enquanto a senha temporária não foi trocada
const LIVRES_COM_SENHA_TEMPORARIA = ["/trocar-senha", "/api/senha", "/api/sessao", "/api/logout", "/login"];

// { pessoaId, regionais: [ids], ufs: [...], municipios: Set(códigos), vazio: bool } ou null (admin)
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
  return { pessoaId: usuario.pessoa_id ?? null, regionais, ufs: [...ufs].sort(), municipios, vazio: municipios.size === 0 };
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

module.exports = { PAPEIS, escopoDe, clausulaMunicipios, dentroDoEscopo, exigirAdmin, exigirSenhaTrocada, paginaInicialDe };
