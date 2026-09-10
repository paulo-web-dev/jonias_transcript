"use strict";

// Prospecção, Fase 4 (2026-09-10): cruzamento do CDR com a prospecção, o Omie
// e as matrículas — SÓ LEITURA sobre os contatos (decisão do usuário: o CDR é
// evidência ao lado; data_ultimo_contato e histórico continuam sendo só o que
// o consultor registrou). Zero IA: tudo é normalização de dígitos + SQL.
//
// Cada ligação recebe uma classe, pela ordem:
//   interna      → número curto (ramal, < 8 dígitos)
//   prospeccao   → o número está em contatos_ativo e todos os contatos são do
//                  MESMO município (o telefone da prefeitura é compartilhado
//                  por dezenas de setores, então o cruzamento confiável é
//                  ligação → município; contato_id só quando o número é único)
//   ambigua      → o número está na prospecção em 2+ municípios — NÃO conta em
//                  nenhum; fica listada para revisão (decisão do usuário)
//   cliente      → número de aluno (matriculas.aluno_telefone)
//   lead         → número de oportunidade do Omie (telefone/celulares)
//   desconhecida → nada bateu
// oportunidade_id e matricula_id são preenchidos sempre que batem, mesmo que a
// classe seja outra (uma prefeitura pode ser cliente E prospecção).
//
// Recalculável: roda inteiro ao fim de cada importação do CDR, da prospecção,
// do Omie e do sync da Unyflex; edição de telefone/município de um contato
// reprocessa só as ligações dos números envolvidos.

const db = require("./db.js");

// Dígitos puros, sem zeros iniciais nem o 55 do país (12–13 dígitos).
function normalizarNumero(v) {
  let n = String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if ((n.length === 12 || n.length === 13) && n.startsWith("55")) n = n.slice(2);
  return n;
}

// Variantes do mesmo número com e sem o nono dígito (celular): "44 9 9721-1407"
// e "44 9721-1407" são a mesma linha — planilha antiga × CDR novo.
function variantes(n) {
  const v = new Set([n]);
  if (n.length === 11 && n[2] === "9") v.add(n.slice(0, 2) + n.slice(3));
  if (n.length === 10 && /[6-9]/.test(n[2])) v.add(n.slice(0, 2) + "9" + n.slice(2));
  return [...v];
}

const indexar = (mapa, chave, valor) => {
  if (!chave) return;
  (mapa.get(chave) ?? mapa.set(chave, []).get(chave)).push(valor);
};

function numeroExternoDe(l) {
  // Saída: o destino é numero_b; entrada/encaminhada: quem chamou é numero_a
  return normalizarNumero(l.sentido === "S" ? l.numero_b : l.numero_a);
}

// Escolha entre oportunidades candidatas: mesma regra do cruzamento de
// matrículas (prefere Conquistada, depois a mais recente)
const escolherOportunidade = (cands) =>
  [...cands].sort((a, b) =>
    (b.status === "Conquistado") - (a.status === "Conquistado") ||
    String(b.incluido_em || "").localeCompare(String(a.incluido_em || ""))
  )[0];

// numeros: lista de números (já normalizados ou não) para reprocessar só as
// ligações deles; ausente = todas as ligações.
function cruzarLigacoes({ numeros = null } = {}) {
  const t0 = Date.now();
  const porContato = new Map();
  for (const c of db.prepare("SELECT id, telefone, whatsapp, codigo_ibge FROM contatos_ativo").all()) {
    for (const t of [c.telefone, c.whatsapp]) {
      const n = normalizarNumero(t);
      if (n.length >= 10) indexar(porContato, n, c);
    }
  }
  const porOportunidade = new Map();
  for (const o of db.prepare("SELECT id, telefone, celular_1, celular_2, status, incluido_em FROM oportunidades").all()) {
    for (const t of [o.telefone, o.celular_1, o.celular_2]) {
      const n = normalizarNumero(t);
      if (n.length >= 10) indexar(porOportunidade, n, o);
    }
  }
  const porMatricula = new Map();
  for (const m of db.prepare("SELECT id, aluno_telefone, criada_em FROM matriculas WHERE aluno_telefone IS NOT NULL").all()) {
    const n = normalizarNumero(m.aluno_telefone);
    if (n.length >= 10) indexar(porMatricula, n, m);
  }

  // Busca exata primeiro; a variante do nono dígito é o único fallback
  const buscar = (mapa, n) => {
    if (mapa.has(n)) return { itens: mapa.get(n), metodo: "exato" };
    for (const v of variantes(n)) if (v !== n && mapa.has(v)) return { itens: mapa.get(v), metodo: "nono_digito" };
    return null;
  };

  let ligacoes = db.prepare("SELECT id, sentido, numero_a, numero_b FROM ligacoes").all();
  if (numeros) {
    const alvo = new Set();
    for (const x of numeros) for (const v of variantes(normalizarNumero(x))) if (v.length >= 8) alvo.add(v);
    ligacoes = ligacoes.filter((l) => variantes(numeroExternoDe(l)).some((v) => alvo.has(v)));
  }

  const atualizar = db.prepare(
    `UPDATE ligacoes SET numero_externo = @numero, classe = @classe, codigo_ibge = @codigo, contato_id = @contato,
       oportunidade_id = @oportunidade, matricula_id = @matricula, cruzamento_metodo = @metodo, cruzado_em = @agora
     WHERE id = @id`
  );
  const agora = new Date().toISOString();
  const contagem = { interna: 0, prospeccao: 0, ambigua: 0, cliente: 0, lead: 0, desconhecida: 0 };
  db.transaction(() => {
    for (const l of ligacoes) {
      const numero = numeroExternoDe(l);
      const r = { id: l.id, numero: numero || null, classe: "desconhecida", codigo: null, contato: null, oportunidade: null, matricula: null, metodo: null, agora };
      if (numero.length < 8) {
        r.classe = "interna";
      } else {
        const p = buscar(porContato, numero);
        const o = buscar(porOportunidade, numero);
        const m = buscar(porMatricula, numero);
        if (o) { r.oportunidade = escolherOportunidade(o.itens).id; r.metodo = o.metodo; }
        if (m) { r.matricula = [...m.itens].sort((a, b) => String(b.criada_em || "").localeCompare(String(a.criada_em || "")))[0].id; r.metodo = m.metodo; }
        if (p) {
          const municipios = new Set(p.itens.map((c) => c.codigo_ibge).filter(Boolean));
          const contatos = new Set(p.itens.map((c) => c.id));
          r.metodo = p.metodo;
          if (municipios.size > 1) {
            r.classe = "ambigua";
          } else {
            r.classe = "prospeccao";
            r.codigo = municipios.size ? [...municipios][0] : null;
            r.contato = contatos.size === 1 ? [...contatos][0] : null;
          }
        } else if (m) {
          r.classe = "cliente";
        } else if (o) {
          r.classe = "lead";
        }
      }
      contagem[r.classe]++;
      atualizar.run(r);
    }
  })();
  return { ligacoes: ligacoes.length, ...contagem, ms: Date.now() - t0 };
}

// Boot: migração que criou as colunas marca cdr_cruzar_pendente; cruza uma vez
function cruzarSePendente() {
  const marca = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'cdr_cruzar_pendente'").get();
  if (!marca) return null;
  const r = cruzarLigacoes();
  db.prepare("DELETE FROM configuracoes WHERE chave = 'cdr_cruzar_pendente'").run();
  return r;
}

// ---------- consultas para as telas ----------

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
function intervalo(de, ate) {
  if (!RE_DATA.test(String(de || "")) || !RE_DATA.test(String(ate || "")) || ate < de) {
    throw Object.assign(new Error("Período inválido — use de=AAAA-MM-DD&ate=AAAA-MM-DD."), { status: 400 });
  }
  return [`${de}T00:00:00`, `${ate}T23:59:59`];
}

// Painel do CDR × carteiras. escopo null = admin (tudo); vendedor = só as
// regionais dele, só as ligações dele nos totais por classe, e terceiros
// aparecem como "outros" sem nome (mesmo rigor do resto da Fase 3).
function painelCdr(de, ate, escopo = null) {
  const [ini, fim] = intervalo(de, ate);
  const pessoaId = escopo ? escopo.pessoaId ?? -2 : null;
  const filtroPessoa = escopo ? "AND l.pessoa_id = ?" : "";
  const valoresPessoa = escopo ? [pessoaId] : [];

  const classes = Object.fromEntries(
    db.prepare(`SELECT COALESCE(classe, 'nao_cruzada') classe, COUNT(*) n, SUM(atendida) atendidas,
                       COUNT(DISTINCT CASE WHEN classe = 'prospeccao' THEN codigo_ibge END) municipios
                FROM ligacoes l WHERE data_hora BETWEEN ? AND ? ${filtroPessoa} GROUP BY 1`).all(ini, fim, ...valoresPessoa)
      .map((r) => [r.classe, { ligacoes: r.n, atendidas: r.atendidas || 0, municipios: r.municipios || 0 }])
  );
  const total = Object.values(classes).reduce((s, c) => s + c.ligacoes, 0);

  const regionaisIds = escopo ? escopo.regionais : null;
  const filtroRegional = regionaisIds ? `AND r.id IN (${regionaisIds.map(() => "?").join(",") || "NULL"})` : "";
  const regionais = db.prepare(
    `SELECT r.id, r.uf, r.sigla, r.nome,
       (SELECT COUNT(DISTINCT c.codigo_ibge) FROM contatos_ativo c JOIN municipios m ON m.codigo_ibge = c.codigo_ibge WHERE m.regional_principal_id = r.id) municipiosComContatos,
       (SELECT COUNT(*) FROM municipios m WHERE m.regional_principal_id = r.id) municipios
     FROM regionais r WHERE 1=1 ${filtroRegional} ORDER BY r.uf, r.sigla`
  ).all(...(regionaisIds || []));
  const porRegional = new Map(regionais.map((r) => [r.id, Object.assign(r, { ligacoes: 0, atendidas: 0, municipiosLigados: 0, foraDaCarteira: 0, porConsultor: [] })]));

  // Ligações de prospecção no período, por regional principal do município e consultor
  const linhas = db.prepare(
    `SELECT m.regional_principal_id regional, l.pessoa_id pessoaId, p.nome, COUNT(*) n, SUM(l.atendida) atendidas
     FROM ligacoes l JOIN municipios m ON m.codigo_ibge = l.codigo_ibge LEFT JOIN pessoas p ON p.id = l.pessoa_id
     WHERE l.classe = 'prospeccao' AND l.data_hora BETWEEN ? AND ? AND m.regional_principal_id IS NOT NULL
     GROUP BY 1, 2`
  ).all(ini, fim);
  const carteiras = new Map();
  for (const c of db.prepare("SELECT regional_id r, pessoa_id p FROM carteiras").all()) (carteiras.get(c.r) ?? carteiras.set(c.r, new Set()).get(c.r)).add(c.p);
  for (const x of linhas) {
    const r = porRegional.get(x.regional);
    if (!r) continue;
    const proprio = !escopo || x.pessoaId === pessoaId;
    const donos = carteiras.get(x.regional);
    const fora = donos && donos.size > 0 && x.pessoaId !== null && !donos.has(x.pessoaId);
    if (escopo && !proprio) {
      // vendedor: terceiros só como agregado "outros"
      let outros = r.porConsultor.find((c) => c.pessoaId === -1);
      if (!outros) r.porConsultor.push((outros = { pessoaId: -1, nome: "outros", ligacoes: 0, atendidas: 0 }));
      outros.ligacoes += x.n; outros.atendidas += x.atendidas || 0;
    } else {
      r.porConsultor.push({ pessoaId: x.pessoaId, nome: x.nome || "sem consultor", ligacoes: x.n, atendidas: x.atendidas || 0 });
    }
    r.ligacoes += x.n; r.atendidas += x.atendidas || 0;
    if (fora) r.foraDaCarteira += x.n;
  }
  // Municípios distintos ligados por regional (não aditivo: consulta própria)
  for (const x of db.prepare(
    `SELECT m.regional_principal_id regional, COUNT(DISTINCT l.codigo_ibge) n FROM ligacoes l JOIN municipios m ON m.codigo_ibge = l.codigo_ibge
     WHERE l.classe = 'prospeccao' AND l.data_hora BETWEEN ? AND ? GROUP BY 1`).all(ini, fim)) {
    const r = porRegional.get(x.regional);
    if (r) r.municipiosLigados = x.n;
  }
  for (const r of regionais) {
    r.nuncaLigados = Math.max(0, r.municipiosComContatos - r.municipiosLigados);
    r.porConsultor.sort((a, b) => b.ligacoes - a.ligacoes);
  }

  const resultado = { de, ate, total, classes, regionais, geradoEm: new Date().toISOString() };
  if (escopo) {
    // municípios da carteira do vendedor nunca ligados no período (para ele agir)
    const cm = require("./escopo.js").clausulaMunicipios(escopo, "m.codigo_ibge");
    resultado.nuncaLigados = db.prepare(
      `SELECT m.codigo_ibge codigo, m.nome, m.uf, r.sigla regional, COUNT(c.id) contatos FROM municipios m
       JOIN regionais r ON r.id = m.regional_principal_id JOIN contatos_ativo c ON c.codigo_ibge = m.codigo_ibge
       WHERE ${cm.sql} AND NOT EXISTS (SELECT 1 FROM ligacoes l WHERE l.classe = 'prospeccao' AND l.codigo_ibge = m.codigo_ibge AND l.data_hora BETWEEN ? AND ?)
       GROUP BY 1 ORDER BY 4 DESC LIMIT 60`
    ).all(...cm.valores, ini, fim);
    return resultado;
  }

  // Só admin: ambíguas para revisão, desconhecidas por DDD, sem regional, por consultor
  resultado.ambiguas = db.prepare(
    `SELECT l.numero_externo numero, COUNT(*) ligacoes, MAX(l.data_hora) ultima FROM ligacoes l
     WHERE l.classe = 'ambigua' AND l.data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 200`
  ).all(ini, fim).map((a) => {
    const vs = variantes(a.numero);
    const marc = vs.map(() => "?").join(",");
    const contatos = db.prepare(
      `SELECT c.id, c.uf, c.codigo_ibge codigo, m.nome municipio, c.setor FROM contatos_ativo c LEFT JOIN municipios m ON m.codigo_ibge = c.codigo_ibge
       WHERE c.telefone IN (${marc}) OR c.whatsapp IN (${marc})`
    ).all(...vs, ...vs);
    const porMunicipio = new Map();
    for (const c of contatos) {
      const chave = c.codigo || 0;
      const g = porMunicipio.get(chave) ?? porMunicipio.set(chave, { codigo: c.codigo, uf: c.uf, municipio: c.municipio || "(sem município)", linhas: 0, ids: [] }).get(chave);
      g.linhas++; g.ids.push(c.id);
    }
    const municipios = [...porMunicipio.values()].sort((x, y) => y.linhas - x.linhas);
    return { ...a, uf: municipios[0]?.uf || null, municipios };
  });
  resultado.desconhecidasPorDdd = db.prepare(
    `SELECT substr(numero_externo, 1, 2) ddd, COUNT(*) n, SUM(atendida) atendidas FROM ligacoes
     WHERE classe = 'desconhecida' AND data_hora BETWEEN ? AND ? AND length(numero_externo) >= 10 GROUP BY 1 ORDER BY 2 DESC`
  ).all(ini, fim);
  resultado.semRegional = db.prepare(
    `SELECT COUNT(*) n FROM ligacoes l LEFT JOIN municipios m ON m.codigo_ibge = l.codigo_ibge
     WHERE l.classe = 'prospeccao' AND l.data_hora BETWEEN ? AND ? AND (l.codigo_ibge IS NULL OR m.regional_principal_id IS NULL)`
  ).get(ini, fim).n;
  resultado.porConsultor = db.prepare(
    `SELECT l.pessoa_id pessoaId, p.nome, COUNT(*) ligacoes, SUM(l.classe = 'prospeccao') prospeccao, SUM(l.classe = 'ambigua') ambiguas,
            SUM(l.classe = 'cliente') clientes, SUM(l.classe = 'lead') leads, SUM(l.classe = 'desconhecida') desconhecidas,
            COUNT(DISTINCT CASE WHEN l.classe = 'prospeccao' THEN l.codigo_ibge END) municipios
     FROM ligacoes l LEFT JOIN pessoas p ON p.id = l.pessoa_id WHERE l.data_hora BETWEEN ? AND ? AND l.classe <> 'interna'
     GROUP BY 1 ORDER BY 3 DESC`
  ).all(ini, fim);
  return resultado;
}

// Por município (para a tela de trabalho): última ligação, total, atendidas e
// quem ligou por último — cortado pelo escopo; para o vendedor, terceiros
// viram -1 (e NULL vira 0 = "sem consultor").
function cdrPorMunicipio(uf, escopo = null) {
  const { clausulaMunicipios } = require("./escopo.js");
  const cm = clausulaMunicipios(escopo, "l.codigo_ibge");
  const pessoaSql = escopo ? "CASE WHEN l.pessoa_id = ? THEN l.pessoa_id WHEN l.pessoa_id IS NULL THEN NULL ELSE -1 END" : "l.pessoa_id";
  const valores = escopo ? [escopo.pessoaId ?? -2] : [];
  const municipios = {};
  for (const r of db.prepare(
    `SELECT l.codigo_ibge codigo, MAX(l.data_hora) ultima, COUNT(*) total, SUM(l.atendida) atendidas
     FROM ligacoes l JOIN municipios m ON m.codigo_ibge = l.codigo_ibge
     WHERE l.classe = 'prospeccao' AND m.uf = ? AND ${cm.sql} GROUP BY 1`).all(uf, ...cm.valores)) {
    municipios[r.codigo] = [r.ultima, r.total, r.atendidas || 0, null];
  }
  for (const r of db.prepare(
    `SELECT l.codigo_ibge codigo, ${pessoaSql} pessoa FROM ligacoes l JOIN municipios m ON m.codigo_ibge = l.codigo_ibge
     WHERE l.classe = 'prospeccao' AND m.uf = ? AND ${cm.sql} ORDER BY l.data_hora DESC`).all(...valores, uf, ...cm.valores)) {
    const x = municipios[r.codigo];
    if (x && x[3] === null) x[3] = r.pessoa ?? 0;
  }
  const contatos = {};
  for (const r of db.prepare(
    `SELECT l.contato_id id, MAX(l.data_hora) ultima, COUNT(*) total FROM ligacoes l JOIN contatos_ativo c ON c.id = l.contato_id
     WHERE l.classe = 'prospeccao' AND c.uf = ? AND ${cm.sql} GROUP BY 1`).all(uf, ...cm.valores)) {
    contatos[r.id] = [r.ultima, r.total];
  }
  return { municipios, contatos };
}

// Ligações de um contato (número exato) e do município dele — para a gaveta
function ligacoesDoContato(contato, escopo = null, limite = 30) {
  const nums = new Set();
  for (const t of [contato.telefone, contato.whatsapp]) for (const v of variantes(normalizarNumero(t))) if (v.length >= 10) nums.add(v);
  const pessoaSql = escopo ? "CASE WHEN l.pessoa_id = ? THEN p.nome WHEN l.pessoa_id IS NULL THEN NULL ELSE 'outro consultor' END" : "p.nome";
  const valores = escopo ? [escopo.pessoaId ?? -2] : [];
  const base = `SELECT l.id, l.data_hora dataHora, l.sentido, l.atendida, l.tempo_conversa_seg conversaSeg, l.evento_falha eventoFalha, ${pessoaSql} consultor,
                  l.numero_externo numero, l.codigo_ibge codigo FROM ligacoes l LEFT JOIN pessoas p ON p.id = l.pessoa_id`;
  const doNumero = nums.size
    ? db.prepare(`${base} WHERE l.numero_externo IN (${[...nums].map(() => "?").join(",")}) ORDER BY l.data_hora DESC LIMIT ?`).all(...valores, ...nums, limite)
    : [];
  const doMunicipio = contato.codigo_ibge
    ? db.prepare(`${base} WHERE l.classe = 'prospeccao' AND l.codigo_ibge = ? ORDER BY l.data_hora DESC LIMIT ?`).all(...valores, contato.codigo_ibge, limite)
    : [];
  const totalMunicipio = contato.codigo_ibge
    ? db.prepare("SELECT COUNT(*) n FROM ligacoes WHERE classe = 'prospeccao' AND codigo_ibge = ?").get(contato.codigo_ibge).n
    : 0;
  return { doNumero, doMunicipio, totalMunicipio };
}

module.exports = { normalizarNumero, variantes, cruzarLigacoes, cruzarSePendente, painelCdr, cdrPorMunicipio, ligacoesDoContato };
