"use strict";
// SOMENTE LEITURA — Fase 0 da tela COBERTURA DA PROSPECÇÃO (pedido do Renato,
// definições aprovadas pelo usuário em 23/11/2026). Mede, antes da tela, as
// três medidas, nunca misturadas:
//   TELEFONE TOCADO   — o número (ou a variante com/sem o nono dígito) recebeu
//                       ligação de SAÍDA no CDR, atendida ou não, de qualquer
//                       vendedor, desde o primeiro CDR importado (agosto/2026:
//                       "nunca tocado" pode ser "antes do sistema existir").
//   CONTATO ABORDADO  — baixa em rota (CDR ou manual; obrigatórias, Extra e
//                       órgãos novos) ou histórico de contato registrado.
//                       A data_ultimo_contato da planilha antiga fica FORA,
//                       contada à parte.
//                       Corte por aba, duas leituras lado a lado:
//                         estrito = o próprio contato;
//                         coberto (opção b) = o contato estrito OU uma baixa
//                         no MESMO número dentro de uma campanha cujo tipo
//                         contém aquela aba (a rota trabalha um telefone por
//                         curso: qual aba recebeu a baixa é escrituração).
//   MUNICÍPIO ALCANÇADO — pelo menos um contato do município abordado.
//                       Dois denominadores: municípios da base e do estado.
// Cortes: UF, regional (principal), aba (+ abas que nunca entraram em rota),
// curso do plano de fim de ano com os donos e a projeção até o FIM DA CAPTAÇÃO
// de cada curso (decisão do usuário, 23/11: "faltariam N dias até 15/12" para
// curso com captação fechada é conta que ninguém pode fazer), vendedor.
// Turmas 2027 (o catálogo, todas as abas) fica FORA da opção (b): nela vale só
// o contato estrito (decisão do usuário, 23/11); a leitura com ela segue ao lado.
// Não usa db.js e não grava nada.
//
//   node scripts/diagnostico-cobertura.js <banco.db>
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/diagnostico-cobertura.js

const arquivo = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!arquivo) { console.error("uso: diagnostico-cobertura.js <banco.db>"); process.exit(1); }
const Database = require("better-sqlite3");
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
const t0 = Date.now();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const g = (sql, ...a) => db.prepare(sql).get(...a);

const FIM = "2026-12-15";
const COTA = 45;
const HOJE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace(".", ",")}%` : "—");
const n = (x) => Number(x || 0).toLocaleString("pt-BR");
const par = (a, b) => `${n(a)}/${n(b)} ${pct(a, b)}`.padStart(22);
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");

// mesma chave da rota (rota.js chaveTelefone): dígitos sem 0/55, a variante
// mais longa entre com e sem o nono dígito
const normalizar = (v) => {
  let x = String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if ((x.length === 12 || x.length === 13) && x.startsWith("55")) x = x.slice(2);
  return x;
};
const variantes = (x) => {
  const v = new Set([x]);
  if (x.length === 11 && x[2] === "9") v.add(x.slice(0, 2) + x.slice(3));
  if (x.length === 10 && /[6-9]/.test(x[2])) v.add(x.slice(0, 2) + "9" + x.slice(2));
  return [...v];
};
const chave = (t) => { const x = normalizar(t); return x.length < 10 ? null : variantes(x).sort((a, b) => b.length - a.length || a.localeCompare(b))[0]; };

// ---------- base ----------
const contatos = q(`SELECT c.id, c.uf, c.setor, c.codigo_ibge cod, c.telefone, c.telefone_valido tv, c.linha_oculta oculta,
    c.contato_inexistente inex, c.data_ultimo_contato duc, COALESCE(c.origem, 'planilha') origem, m.regional_principal_id reg
  FROM contatos_ativo c LEFT JOIN municipios m ON m.codigo_ibge = c.codigo_ibge`);
for (const c of contatos) {
  c.chave = c.tv === 1 ? chave(c.telefone) : null;
  c.apto = !!c.chave && !c.oculta && !c.inex;
}
const regionais = new Map(q("SELECT id, uf, sigla, nome FROM regionais").map((r) => [r.id, r]));
const municipiosEstado = Object.fromEntries(q("SELECT uf, COUNT(*) n FROM municipios GROUP BY uf").map((r) => [r.uf, r.n]));

// ---------- telefone tocado (CDR, saída) ----------
const cdr = g("SELECT MIN(data_hora) a, MAX(data_hora) b, COUNT(*) n FROM ligacoes WHERE sentido = 'S'");
const SQL_QUEM = `COALESCE((SELECT v.pessoa_id FROM ramal_vigencias v WHERE v.ramal = l.ramal
    AND (v.vigente_desde IS NULL OR v.vigente_desde <= substr(l.data_hora, 1, 10))
    AND (v.vigente_ate IS NULL OR substr(l.data_hora, 1, 10) <= v.vigente_ate)
    ORDER BY v.vigente_desde DESC LIMIT 1), l.pessoa_id)`;
const tocados = new Set();
const tocadosPor = new Map(); // pessoaId → Set(chave)
for (const l of q(`SELECT l.numero_externo num, ${SQL_QUEM} pessoa FROM ligacoes l WHERE l.sentido = 'S' AND l.numero_externo IS NOT NULL`)) {
  const k = chave(l.num);
  if (!k) continue;
  tocados.add(k);
  if (l.pessoa != null) (tocadosPor.get(l.pessoa) ?? tocadosPor.set(l.pessoa, new Set()).get(l.pessoa)).add(k);
}

// ---------- contato abordado ----------
const tipos = new Map(q("SELECT id, nome, setores_json s, cota FROM rota_tipos").map((t) => [t.id, { ...t, abas: new Set(JSON.parse(t.s || "[]").map((x) => `${x.uf}|${x.setor}`)) }]));
const itens = q(`SELECT i.contato_id cid, i.telefone, i.baixa_metodo baixa, i.extra, COALESCE(i.tipo_id, r.tipo_id) tipo, r.data, r.pessoa_id pessoa
  FROM rota_itens i JOIN rotas r ON r.id = i.rota_id`);
const abordado = new Map();   // contatoId → Set(origem: rota|registro)
const abordadoPor = new Map(); // pessoaId → Set(contatoId)
const marca = (cid, origem, pessoa) => {
  (abordado.get(cid) ?? abordado.set(cid, new Set()).get(cid)).add(origem);
  if (pessoa != null) (abordadoPor.get(pessoa) ?? abordadoPor.set(pessoa, new Set()).get(pessoa)).add(cid);
};
// Turmas 2027 tem TODAS as abas (complemento de todo dia): pela opção (b),
// uma baixa nela cobriria todos os setores do número. Medido à parte, para
// o usuário decidir se entra (ponto em aberto da Fase 0).
const amplos = new Set(q("SELECT tipo_id t FROM fim_ano_cursos WHERE papel = '2027'").map((r) => r.t));
const cobertoPar = new Set(); // "uf|setor|chave" — opção (b), sem os tipos amplos
const cobertoParAmplo = new Set(); // só pelos tipos amplos (Turmas 2027)
const setoresEmRota = new Set(); // abas que algum item de rota já trouxe (com ou sem baixa)
const porId = new Map(contatos.map((c) => [c.id, c]));
for (const i of itens) {
  const c = porId.get(i.cid);
  if (c) setoresEmRota.add(`${c.uf}|${c.setor}`);
  if (!i.baixa) continue;
  marca(i.cid, "rota", i.pessoa);
  const k = chave(i.telefone) || c?.chave;
  const t = tipos.get(i.tipo);
  if (k && t) for (const aba of t.abas) (amplos.has(i.tipo) ? cobertoParAmplo : cobertoPar).add(`${aba}|${k}`);
}
const registros = q(`SELECT h.contato_id cid, u.pessoa_id pessoa FROM contatos_ativo_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id WHERE h.tipo = 'contato'`);
for (const r of registros) marca(r.cid, "registro", r.pessoa);
for (const c of contatos) {
  c.abordado = abordado.has(c.id);
  c.coberto = c.abordado || (!!c.chave && cobertoPar.has(`${c.uf}|${c.setor}|${c.chave}`));
  c.cobertoAmplo = c.coberto || (!!c.chave && cobertoParAmplo.has(`${c.uf}|${c.setor}|${c.chave}`));
  c.soPlanilha = !c.abordado && !!c.duc;
  c.tocado = !!c.chave && tocados.has(c.chave);
}

// ---------- agregador ----------
function medir(lista) {
  const tel = new Set(), telT = new Set(), mun = new Set(), munA = new Set();
  let ab = 0, cob = 0, cobA = 0, pl = 0, aptos = 0;
  for (const c of lista) {
    if (c.apto) aptos++;
    if (c.chave) { tel.add(c.chave); if (c.tocado) telT.add(c.chave); }
    if (c.cod) { mun.add(c.cod); if (c.abordado) munA.add(c.cod); }
    if (c.abordado) ab++;
    if (c.coberto) cob++;
    if (c.cobertoAmplo) cobA++;
    if (c.soPlanilha) pl++;
  }
  return { contatos: lista.length, aptos, abordados: ab, cobertos: cob, cobertosAmplo: cobA, soPlanilha: pl, telefones: tel.size, tocados: telT.size, municipios: mun.size, alcancados: munA.size };
}
const agrupar = (lista, f) => { const m = new Map(); for (const c of lista) { const k = f(c); (m.get(k) ?? m.set(k, []).get(k)).push(c); } return m; };

// ---------- saída ----------
console.log(`banco: ${arquivo} · user_version ${db.pragma("user_version", { simple: true })} · hoje ${dataBr(HOJE)} (Brasília)`);
console.log(`CDR de saída: ${n(cdr.n)} ligação(ões), de ${dataBr(cdr.a?.slice(0, 10))} a ${dataBr(cdr.b?.slice(0, 10))}.`);
console.log(`⚠ "nunca tocado" quer dizer nunca DESDE ${dataBr(cdr.a?.slice(0, 10))} — antes disso o sistema não via as ligações.`);
console.log(`\nAS TRÊS MEDIDAS (nunca somar uma com a outra):`);
console.log(`  telefone tocado  = o número recebeu ligação de saída no CDR. Mede alcance do NÚMERO, não a oferta: o número da prefeitura é de vários setores.`);
console.log(`  contato abordado = aquele contato teve baixa em rota ou contato registrado. É a que diz se o setor foi abordado.`);
console.log(`  município alcançado = pelo menos um contato abordado no município.`);

// 1. UF
const todos = medir(contatos);
console.log(`\n=== 1. POR UF`);
console.log(`  UF   contatos (aptos)    telefones tocados       contatos abordados     só planilha antiga   municípios alcançados  ÷ base / ÷ estado        base cobre`);
for (const [uf, lista] of [...agrupar(contatos, (c) => c.uf)].sort()) {
  const m = medir(lista), est = municipiosEstado[uf] || 0;
  console.log(`  ${uf}  ${n(m.contatos).padStart(7)} (${n(m.aptos).padStart(6)}) ${par(m.tocados, m.telefones)} ${par(m.abordados, m.contatos)} ${n(m.soPlanilha).padStart(12)}        ${n(m.alcancados).padStart(4)}  ${pct(m.alcancados, m.municipios).padStart(6)} / ${pct(m.alcancados, est).padStart(6)}     ${n(m.municipios)} dos ${n(est)} municípios`);
}
console.log(`  total ${n(todos.contatos)} contatos · ${n(todos.aptos)} aptos (telefone válido, visível, não inexistente) · ${n(todos.telefones)} telefones distintos`);
const orig = agrupar(contatos.filter((c) => c.abordado), (c) => [...abordado.get(c.id)].sort().join("+"));
console.log(`  abordados por origem: ${[...orig].map(([k, v]) => `${k} ${n(v.length)}`).join(" · ")}`);
console.log(`  sem município casado: ${n(contatos.filter((c) => !c.cod).length)} contato(s) (fora da conta de municípios)`);

// 2. regional
console.log(`\n=== 2. POR REGIONAL (regional principal do município)`);
console.log(`  regional          contatos    telefones tocados       contatos abordados   municípios alcançados (÷ base / ÷ regional)`);
const munPorRegional = new Map(q("SELECT regional_principal_id r, COUNT(*) n FROM municipios WHERE regional_principal_id IS NOT NULL GROUP BY 1").map((r) => [r.r, r.n]));
const porReg = agrupar(contatos, (c) => c.reg ?? 0);
for (const [id, r] of [...regionais].sort((a, b) => a[1].uf.localeCompare(b[1].uf) || a[1].sigla.localeCompare(b[1].sigla))) {
  const m = medir(porReg.get(id) || []), tot = munPorRegional.get(id) || 0;
  console.log(`  ${`${r.uf} ${r.sigla}`.padEnd(16)} ${n(m.contatos).padStart(8)} ${par(m.tocados, m.telefones)} ${par(m.abordados, m.contatos)}   ${n(m.alcancados).padStart(3)} de ${n(m.municipios).padStart(3)} na base / ${n(tot)} na regional`);
}
if (porReg.get(0)) { const m = medir(porReg.get(0)); console.log(`  sem regional     ${n(m.contatos).padStart(8)} ${par(m.tocados, m.telefones)} ${par(m.abordados, m.contatos)}`); }

// 3. aba
console.log(`\n=== 3. POR ABA (setor) — abordado ESTRITO × COBERTO (opção b), lado a lado`);
console.log(`  UF  aba                                  contatos  aptos   estrito                coberto (b)            (b) + Turmas 2027      telefones tocados   em rota?`);
const porAba = [...agrupar(contatos, (c) => `${c.uf}|${c.setor}`)].sort((a, b) => a[0].localeCompare(b[0]));
for (const [k, lista] of porAba) {
  const m = medir(lista), [uf, setor] = k.split("|");
  console.log(`  ${uf}  ${String(setor).slice(0, 36).padEnd(36)} ${n(m.contatos).padStart(7)} ${n(m.aptos).padStart(6)} ${par(m.abordados, m.contatos)} ${par(m.cobertos, m.contatos)} ${par(m.cobertosAmplo, m.contatos)} ${par(m.tocados, m.telefones)}   ${setoresEmRota.has(k) ? "sim" : "NUNCA"}`);
}
const nunca = porAba.filter(([k]) => !setoresEmRota.has(k));
console.log(`  abas que NUNCA entraram em rota nenhuma: ${nunca.length} de ${porAba.length} (${n(nunca.reduce((s, [, l]) => s + l.length, 0))} contatos)`);
for (const [k, l] of nunca) console.log(`    ${k.replace("|", " ")} — ${n(l.length)} contato(s), ${n(l.filter((c) => c.apto).length)} aptos`);

// 4. cursos do fim de ano + projeção
console.log(`\n=== 4. CURSOS DO PLANO DE FIM DE ANO — telefones do curso (unidade da rota) e projeção até o fim da captação de cada curso`);
console.log(`  coberto = telefone com baixa numa rota DESTE curso; planejado = nas rotas já geradas de hoje em diante, sem baixa, ainda não coberto
  (a rota só traz o curso enquanto a captação está aberta).`);
console.log(`  A projeção supõe todas as rotas geradas trabalhadas: é o teto do plano atual, não uma previsão.`);
const cursos = q(`SELECT c.tipo_id tipo, c.curso, c.papel, c.captacao_de de, c.captacao_ate ate FROM fim_ano_cursos c ORDER BY c.ordem`);
const nomes = new Map(q("SELECT id, nome FROM pessoas").map((p) => [p.id, p.nome]));
const feriados = new Set(q("SELECT data FROM feriados").map((r) => r.data));
const somarDias = (d, k) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const uteis = (de, ate) => { let k = 0; for (let d = de; d <= ate; d = somarDias(d, 1)) { const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w > 0 && w < 6 && !feriados.has(d)) k++; } return k; };
const tocadosDoTipo = (abas) => contatos.filter((c) => c.apto && abas.has(`${c.uf}|${c.setor}`));
for (const c of cursos.filter((x) => x.papel !== "novos")) {
  const t = tipos.get(c.tipo);
  if (!t) continue;
  const universo = new Set(tocadosDoTipo(t.abas).map((x) => x.chave));
  const coberto = new Set(), planejado = new Set();
  for (const i of itens) {
    if (i.tipo !== c.tipo) continue;
    const k = chave(i.telefone) || porId.get(i.cid)?.chave;
    if (!k) continue;
    if (i.baixa) coberto.add(k); else if (i.data >= HOJE) planejado.add(k);
  }
  for (const k of coberto) planejado.delete(k);
  const cob = [...coberto].filter((k) => universo.has(k)).length, pla = [...planejado].filter((k) => universo.has(k)).length;
  const resto = universo.size - cob - pla;
  const donos = q("SELECT pessoa_id p, COUNT(*) d FROM fim_ano_plano WHERE tipo_id = ? AND data >= ? GROUP BY 1 ORDER BY 2 DESC", c.tipo, HOJE)
    .map((r) => `${nomes.get(r.p)} ${r.d}d`).join(", ") || "ninguém daqui em diante";
  const tocU = [...universo].filter((k) => tocados.has(k)).length;
  const fimCapt = c.ate < FIM ? c.ate : FIM;
  const restam = HOJE > fimCapt ? 0 : uteis(HOJE > c.de ? HOJE : c.de, fimCapt);
  console.log(`  ${c.curso.slice(0, 44).padEnd(44)} captação ${dataBr(c.de).slice(0, 5)}–${dataBr(c.ate).slice(0, 5)} (${restam ? `restam ${restam} dia(s) úteis` : "ENCERRADA"}) · donos (dias no plano daqui em diante): ${donos}`);
  console.log(`      ${n(universo.size)} telefones · coberto ${n(cob)} (${pct(cob, universo.size)}) · planejado ${n(pla)} · cobre ${pct(cob + pla, universo.size)} da base até ${restam ? `o fim da captação (${dataBr(fimCapt).slice(0, 5)})` : "aqui (captação encerrada)"}` +
    (resto <= 0 ? " · fecha" : restam ? ` · faltariam ${n(resto)} telefones = ${n(Math.ceil(resto / COTA))} dias-vendedor de ${COTA}, com ${restam} dia(s) úteis de captação` : ` · ${n(resto)} telefones ficaram sem oferta`) + ` · tocados (qualquer campanha) ${pct(tocU, universo.size)}`);
}
const novos = contatos.filter((c) => c.origem === "orgaos_novos");
if (novos.length) {
  const m = medir(novos);
  console.log(`  Órgãos novos (contato, não telefone: ${n(novos.filter((c) => !c.chave).length)} sem telefone): ${par(m.abordados, m.contatos)} abordados`);
}

// 5. vendedor (só contagens)
console.log(`\n=== 5. POR VENDEDOR (só contagens; na tela o vendedor também não recebe lista)`);
console.log(`  abordados = baixa nas rotas dele + contatos que o usuário dele registrou; tocados = saída do ramal dele (dono pela vigência), número na base.`);
const baseChaves = new Set(contatos.filter((c) => c.chave).map((c) => c.chave));
const ids = new Set([...abordadoPor.keys(), ...tocadosPor.keys()]);
const pessoas = q("SELECT id, nome, ativo, entra_painel, tipo FROM pessoas").filter((p) => ids.has(p.id) && p.tipo === "consultor");
console.log(`  vendedor        contatos abordados   telefones tocados   municípios alcançados`);
for (const p of pessoas.sort((a, b) => b.entra_painel - a.entra_painel || a.nome.localeCompare(b.nome))) {
  const ab = abordadoPor.get(p.id) || new Set();
  const mun = new Set([...ab].map((id) => porId.get(id)?.cod).filter(Boolean));
  const tc = [...(tocadosPor.get(p.id) || [])].filter((k) => baseChaves.has(k)).length;
  console.log(`  ${p.nome.padEnd(14)} ${n(ab.size).padStart(10)}           ${n(tc).padStart(8)}            ${n(mun.size).padStart(6)}${p.entra_painel ? "" : "   (fora do painel)"}`);
}
console.log(`\n(${Date.now() - t0} ms)`);
