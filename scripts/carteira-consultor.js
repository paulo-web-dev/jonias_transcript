"use strict";
// SOMENTE LEITURA — carteira de um consultor e o que fica órfão se ele sair
// (feito para a saída do Jhonnata, 2026-10-02; serve para qualquer nome).
// Não depende de db.js (não roda migração): rode ANTES do deploy da migração
// 30, que remove os vínculos de carteira dele — depois disso não há mais o
// que mostrar (o log da migração repete este retrato).
//
//   node scripts/carteira-consultor.js <arquivo.db> [nome]
//   docker compose exec -T jonias node - /app/data/aula-ai.db Jhonnata < scripts/carteira-consultor.js
//
// Por regional em que ele está: papel dele, quem continua (titular/apoios),
// situação depois da saída (ÓRFÃ = ninguém; SEM TITULAR = só apoios), contatos
// da regional (regional principal do município), quantos estão no nome dele,
// sem consultor e aptos para rota (telefone válido, não inexistente, não oculto).

const Database = require("better-sqlite3");

const [arquivo, nome = "Jhonnata"] = process.argv.slice(2);
if (!arquivo) {
  console.error("uso: carteira-consultor.js <arquivo.db> [nome]");
  process.exit(1);
}
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
console.log(`user_version ${db.pragma("user_version", { simple: true })}`);

const pessoa = db.prepare("SELECT id, nome, ramal, ativo FROM pessoas WHERE nome = ? AND tipo = 'consultor'").get(nome);
if (!pessoa) {
  console.error(`consultor "${nome}" não encontrado`);
  process.exit(1);
}
console.log(`${pessoa.nome} (id ${pessoa.id}, ramal ${pessoa.ramal ?? "—"})\n`);

const vinculos = db.prepare(
  `SELECT c.regional_id id, c.papel, r.uf, r.sigla, r.nome FROM carteiras c JOIN regionais r ON r.id = c.regional_id
   WHERE c.pessoa_id = ? ORDER BY r.uf, r.sigla`
).all(pessoa.id);
if (!vinculos.length) console.log("Sem vínculos de carteira.");

const outrosDe = db.prepare(
  `SELECT p.nome, c.papel FROM carteiras c JOIN pessoas p ON p.id = c.pessoa_id
   WHERE c.regional_id = ? AND c.pessoa_id <> ? ORDER BY c.papel DESC, p.nome`
);
const contagem = db.prepare(
  `SELECT COUNT(*) total, COALESCE(SUM(a.pessoa_id = @p), 0) dele, COALESCE(SUM(a.pessoa_id IS NULL), 0) semConsultor,
     COALESCE(SUM(a.telefone_valido = 1 AND a.telefone IS NOT NULL AND COALESCE(a.contato_inexistente, 0) = 0
       AND COALESCE(a.linha_oculta, 0) = 0 AND (a.pessoa_id IS NULL OR a.pessoa_id = @p)), 0) aptos
   FROM contatos_ativo a JOIN municipios m ON m.codigo_ibge = a.codigo_ibge WHERE m.regional_principal_id = @r`
);
const linhas = vinculos.map((v) => {
  const outros = outrosDe.all(v.id, pessoa.id);
  const titular = outros.find((o) => o.papel === "titular");
  const n = contagem.get({ p: pessoa.id, r: v.id });
  return {
    regional: `${v.uf} ${v.sigla}`, nome: v.nome, papel: v.papel,
    situacao: !outros.length ? "ÓRFÃ" : !titular ? "SEM TITULAR" : "coberta",
    continuam: outros.map((o) => `${o.nome}${o.papel === "apoio" ? " (apoio)" : ""}`).join(", ") || "—",
    contatos: n.total, dele: n.dele, semConsultor: n.semConsultor, aptosRota: n.aptos,
  };
});
if (linhas.length) console.table(linhas);

const orfas = linhas.filter((l) => l.situacao !== "coberta");
console.log(`\n${orfas.length} regional(is) a redistribuir (órfã ou sem titular): ` +
  `${orfas.reduce((s, l) => s + l.contatos, 0)} contato(s), ${orfas.reduce((s, l) => s + l.dele, 0)} no nome dele.`);
const total = db.prepare("SELECT COUNT(*) n FROM contatos_ativo WHERE pessoa_id = ?").get(pessoa.id).n;
const fora = total - linhas.reduce((s, l) => s + l.dele, 0);
console.log(`contatos no nome dele na base inteira: ${total}` + (fora ? ` (${fora} fora das regionais da carteira dele)` : ""));
const usuarios = db.prepare("SELECT login, papel, ativo FROM usuarios WHERE pessoa_id = ?").all(pessoa.id);
console.log(`usuário(s) ligado(s): ${usuarios.map((u) => `${u.login} (${u.papel}${u.ativo ? "" : ", inativo"})`).join(", ") || "nenhum"}`);
try {
  const rotas = db.prepare(
    `SELECT r.data, COUNT(i.id) itens, COALESCE(SUM(i.baixa_metodo IS NOT NULL), 0) feitas FROM rotas r
     LEFT JOIN rota_itens i ON i.rota_id = r.id WHERE r.pessoa_id = ? GROUP BY r.id ORDER BY r.data DESC LIMIT 10`
  ).all(pessoa.id);
  console.log(`rotas mais recentes: ${rotas.map((r) => `${r.data} ${r.feitas}/${r.itens}`).join(" · ") || "nenhuma"}`);
} catch { /* banco sem a migração 28 */ }
