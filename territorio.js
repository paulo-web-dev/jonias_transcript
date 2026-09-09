"use strict";

// Inteligência comercial por território — referência (regionais/municípios de
// PR e SC), casamento de students.city (texto livre) com o município oficial,
// cobertura do casamento, revisão manual e agregação por estado/regional/
// município. Tudo em SQL/JS determinístico — nenhum número sai de modelo de
// linguagem.
//
// Casamento em camadas, da mais confiável para a menos, sempre gravando
// método + confiança em municipio_apelidos (1 linha por cidade+UF
// normalizadas) e copiando para matriculas.codigo_ibge/municipio_*/aluno_uf:
//   exato_uf   nome + UF (state, CEP ou sufixo "/PR") batem            alta
//   exato      nome único em PR+SC, sem UF                              alta
//   fora_*     UF/CEP de outro estado, ou cidade que só existe fora     media
//   aproximado Levenshtein ≤ min(2, 20% do tamanho), candidato único    media
//   pendente   homônimo PR/SC sem UF, conflito cidade×UF, sem match     — (revisão manual)
//   manual     resolvido na tela /territorio — nunca é sobrescrito      manual
// Resultado automático também fica em municipio_apelidos e não muda entre
// syncs (estabilidade); só a resolução manual substitui.

const fs = require("fs");
const path = require("path");
const db = require("./db.js");
const { normalizarNome, removerBom, lerCsv } = require("./importacao.js");
const { calcularMetricas } = require("./metricas.js");

const DADOS = path.join(__dirname, "dados");
const ARQ_CSV_REGIONAIS = path.join(DADOS, "regionais_municipios_PR_SC.csv");
const ARQ_MUNICIPIOS_PR_SC = path.join(DADOS, "municipios_ibge_PR_SC.json");
const ARQ_MUNICIPIOS_BRASIL = path.join(DADOS, "municipios_brasil.json");
const ARQ_MAPA = path.join(DADOS, "mapa_PR_SC.svg");
const ARQ_VIZINHOS = path.join(DADOS, "vizinhos_PR_SC.json");

const UFS_TERRITORIO = ["PR", "SC"];
const DISTANCIA_MAXIMA = 2; // Levenshtein — limiar alto de propósito

// Mesmo filtro de matrícula válida de metricas.js (status NULL conta; só 'canceled' sai)
const FILTRO_MATRICULA_VALIDA = "(status IS NULL OR status != 'canceled')";

// ---------- UF: siglas, nomes por extenso e faixas de CEP ----------

const NOMES_UF = {
  ac: "AC", acre: "AC", al: "AL", alagoas: "AL", ap: "AP", amapa: "AP", am: "AM", amazonas: "AM",
  ba: "BA", bahia: "BA", ce: "CE", ceara: "CE", df: "DF", "distrito federal": "DF",
  es: "ES", "espirito santo": "ES", go: "GO", goias: "GO", ma: "MA", maranhao: "MA",
  mt: "MT", "mato grosso": "MT", ms: "MS", "mato grosso do sul": "MS", mg: "MG", "minas gerais": "MG",
  pa: "PA", para: "PA", pb: "PB", paraiba: "PB", pr: "PR", parana: "PR", pe: "PE", pernambuco: "PE",
  pi: "PI", piaui: "PI", rj: "RJ", "rio de janeiro": "RJ", rn: "RN", "rio grande do norte": "RN",
  rs: "RS", "rio grande do sul": "RS", ro: "RO", rondonia: "RO", rr: "RR", roraima: "RR",
  sc: "SC", "santa catarina": "SC", sp: "SP", "sao paulo": "SP", se: "SE", sergipe: "SE",
  to: "TO", tocantins: "TO",
};
const RE_SIGLA_EMBUTIDA =
  /\b(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b/;

// Faixas oficiais de CEP por UF (prefixo de 5 dígitos, inclusive)
const FAIXAS_CEP = [
  [1000, 19999, "SP"], [20000, 28999, "RJ"], [29000, 29999, "ES"], [30000, 39999, "MG"],
  [40000, 48999, "BA"], [49000, 49999, "SE"], [50000, 56999, "PE"], [57000, 57999, "AL"],
  [58000, 58999, "PB"], [59000, 59999, "RN"], [60000, 63999, "CE"], [64000, 64999, "PI"],
  [65000, 65999, "MA"], [66000, 68899, "PA"], [68900, 68999, "AP"], [69000, 69299, "AM"],
  [69300, 69399, "RR"], [69400, 69899, "AM"], [69900, 69999, "AC"], [70000, 72799, "DF"],
  [72800, 72999, "GO"], [73000, 73699, "DF"], [73700, 76799, "GO"], [76800, 76999, "RO"],
  [77000, 77999, "TO"], [78000, 78899, "MT"], [79000, 79999, "MS"], [80000, 87999, "PR"],
  [88000, 89999, "SC"], [90000, 99999, "RS"],
];

// Texto de UF ("PR", "Paraná", "Parana (PR)", "Es") → sigla ou null
function normalizarUfTexto(texto) {
  const n = normalizarNome(texto).replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (NOMES_UF[n]) return NOMES_UF[n];
  const m = n.match(RE_SIGLA_EMBUTIDA);
  return m ? m[1].toUpperCase() : null;
}

// CEP (só dígitos) → sigla da UF ou null (CEP zerado/curto não vale)
function ufPorCep(cep) {
  const d = String(cep || "").replace(/\D/g, "");
  if (d.length !== 8) return null;
  const prefixo = Number(d.slice(0, 5));
  const faixa = FAIXAS_CEP.find(([ini, fim]) => prefixo >= ini && prefixo <= fim);
  return faixa ? faixa[2] : null;
}

// state (texto livre) tem prioridade; sem state legível, vale a faixa do CEP.
function resolverUf(state, cep) {
  const texto = normalizarUfTexto(state);
  if (texto) return { uf: texto, origem: "texto" };
  const porCep = ufPorCep(cep);
  return porCep ? { uf: porCep, origem: "cep" } : { uf: null, origem: null };
}
const normalizarUf = (state, cep) => resolverUf(state, cep).uf;

// ---------- Cidade: normalização do texto livre ----------

// "SÃ£o JoÃ£o" (utf-8 lido como latin1 e gravado de novo) → "São João"
function desfazerMojibake(texto) {
  if (!/[ÃÂ][\x80-\xBF]/.test(texto)) return texto;
  try {
    const corrigido = Buffer.from(texto, "latin1").toString("utf8");
    return corrigido.includes("�") ? texto : corrigido;
  } catch (_) {
    return texto;
  }
}

// Sufixo de UF no próprio campo cidade: "Cascavel / PR", "Toledo - PR",
// "Curitiba (Paraná)". Exige separador com espaço ou "/" ou "(" — hífen colado
// ("Ji-Paraná") é parte do nome.
const RE_SUFIXO_UF = /^(.*?)\s*(?:\/|\(|\s[-–]\s)\s*([A-Za-zÀ-ÿ .]{2,25})\)?\s*$/;

// Devolve { nome, ufNoTexto }: nome sem acento/pontuação/caixa, espaços
// únicos, "d'oeste"/"d oeste" → "do oeste" (mesma regra aplicada aos nomes
// oficiais, então os dois lados convergem). Nome vazio/numérico → "".
function normalizarCidade(bruto) {
  let s = desfazerMojibake(String(bruto ?? "")).replace(/\s+/g, " ").trim();
  let ufNoTexto = null;
  const m = s.match(RE_SUFIXO_UF);
  if (m) {
    const uf = normalizarUfTexto(m[2]);
    if (uf) {
      ufNoTexto = uf;
      s = m[1];
    }
  }
  let nome = normalizarNome(s)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bd (?=[aeiou])/g, "do ");
  if (nome.length < 2 || /^\d+$/.test(nome)) nome = "";
  return { nome, ufNoTexto };
}

// Cidade como vem nas planilhas de prospecção: "APUCARANA (LIGAR APÓS 12H00)",
// "CRUZMALTINA (SÓ CHAMA )", "Campo largo - Consorcio da GM/PR = COIN - 41 3000-0000".
// Tira anotações entre parênteses/colchetes e o que vem depois de " - ", " = ",
// ":" ou de um telefone. O texto original fica em municipio_texto; só a chave usa o limpo.
function limparCidadeAnotada(texto) {
  return String(texto ?? "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s[-–=:]\s.*$/, " ")
    .replace(/\s\d[\d\s().-]{6,}.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Chave (cidade, UF) de um contato da prospecção: UF vem do upload; sufixo
// "/PR" no texto prevalece.
function chaveDoContato(c) {
  const { nome, ufNoTexto } = normalizarCidade(limparCidadeAnotada(c.municipio_texto));
  if (!nome) return null;
  const uf = ufNoTexto || c.uf || null;
  return { nome, uf, chave: `${nome}|${uf || ""}` };
}

// Chave (cidade, UF) de uma matrícula — única definição, usada em todo lugar
function chaveDaMatricula(m) {
  const { nome, ufNoTexto } = normalizarCidade(m.aluno_cidade);
  if (!nome) return null;
  const r = ufNoTexto ? { uf: ufNoTexto, origem: "texto" } : resolverUf(m.aluno_estado, m.aluno_cep);
  return { nome, uf: r.uf, origem: r.origem, chave: `${nome}|${r.uf || ""}` };
}

// ---------- Índices de referência (cache em memória) ----------

let indiceCache = null;
let brasilCache = null;

function invalidarIndice() {
  indiceCache = null;
}

// Municípios de PR/SC a partir da TABELA (fonte única após o boot)
function indiceMunicipios() {
  if (indiceCache) return indiceCache;
  const lista = db
    .prepare("SELECT codigo_ibge AS codigo, uf, nome, nome_normalizado FROM municipios ORDER BY uf, nome")
    .all();
  const porNome = new Map();
  for (const m of lista) {
    (porNome.get(m.nome_normalizado) ?? porNome.set(m.nome_normalizado, []).get(m.nome_normalizado)).push(m);
  }
  indiceCache = { lista, porNome };
  return indiceCache;
}

// Nome normalizado → Set(UF) de TODOS os municípios do Brasil (só para
// reconhecer cidade que existe apenas fora de PR/SC)
function indiceBrasil() {
  if (brasilCache) return brasilCache;
  brasilCache = new Map();
  if (fs.existsSync(ARQ_MUNICIPIOS_BRASIL)) {
    for (const m of JSON.parse(fs.readFileSync(ARQ_MUNICIPIOS_BRASIL, "utf8"))) {
      const n = normalizarCidade(m.nome).nome;
      (brasilCache.get(n) ?? brasilCache.set(n, new Set()).get(n)).add(m.uf);
    }
  }
  return brasilCache;
}

function ufUnicaNoBrasil(nome) {
  const ufs = indiceBrasil().get(nome);
  return ufs && ufs.size === 1 ? [...ufs][0] : null;
}

// Vizinhança geográfica (dados/vizinhos_PR_SC.json, derivado da malha do IBGE
// pelo script de referência): código → [códigos vizinhos]
let vizinhosCache = null;
function indiceVizinhos() {
  if (vizinhosCache) return vizinhosCache;
  vizinhosCache = new Map();
  if (fs.existsSync(ARQ_VIZINHOS)) {
    for (const [c, lista] of Object.entries(JSON.parse(fs.readFileSync(ARQ_VIZINHOS, "utf8")))) {
      vizinhosCache.set(Number(c), lista.map(Number));
    }
  }
  return vizinhosCache;
}

// ---------- Distância de edição ----------

function levenshtein(a, b, limite = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limite) return limite + 1;
  let anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(anterior[j] + 1, atual[j - 1] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (atual[j] < menor) menor = atual[j];
    }
    if (menor > limite) return limite + 1; // nenhuma célula desta linha volta a ficar ≤ limite
    anterior = atual;
  }
  return anterior[b.length];
}

// Candidatos por distância pura (camada automática "aproximado")
function candidatosProximos(nome, uf, maximo = 3) {
  const { lista } = indiceMunicipios();
  const base = UFS_TERRITORIO.includes(uf) ? lista.filter((m) => m.uf === uf) : lista;
  return base
    .map((m) => ({ codigo: m.codigo, nome: m.nome, uf: m.uf, distancia: levenshtein(nome, m.nome_normalizado, 6) }))
    .sort((a, b) => a.distancia - b.distancia || a.nome.localeCompare(b.nome))
    .slice(0, maximo);
}

// Sugestões para a revisão manual (mais amplas que a camada automática):
// homônimo em outra UF ("Concórdia/PR" → Concórdia SC), município contido no
// texto ("Câmara de Joinville" → Joinville), texto que é prefixo do nome
// ("Bela Vista" → Bela Vista da Caroba / do Paraíso / do Toldo) e, por fim,
// distância de edição. Sempre inclui as duas UFs — a decisão é do revisor.
function sugerirCandidatos(nome, uf, maximo = 4) {
  const { lista } = indiceMunicipios();
  const ufTerritorio = UFS_TERRITORIO.includes(uf);
  const texto = ` ${nome} `;
  return lista
    .map((m) => {
      const n = m.nome_normalizado;
      let motivo = "proximo";
      let prioridade = 3;
      if (n === nome) { motivo = "homonimo"; prioridade = 0; }
      else if (nome.length >= 4 && texto.includes(` ${n} `)) { motivo = "contido"; prioridade = 1; }
      else if (nome.length >= 4 && n.startsWith(`${nome} `)) { motivo = "prefixo"; prioridade = 2; }
      const distancia = levenshtein(nome, n, 6);
      if (motivo === "proximo" && distancia > 6) return null;
      return {
        codigo: m.codigo, nome: m.nome, uf: m.uf, distancia, motivo,
        ordem: prioridade + (ufTerritorio && m.uf !== uf ? 0.5 : 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ordem - b.ordem || a.distancia - b.distancia || a.nome.localeCompare(b.nome))
    .slice(0, maximo)
    .map(({ ordem, ...s }) => s);
}

// ---------- Classificação em camadas ----------

function classificarCidade(nome, uf, origemUf = "texto") {
  const { porNome } = indiceMunicipios();
  const municipio = (m, metodo, confianca, distancia = null) => ({
    resultado: "municipio", codigo_ibge: m.codigo, metodo, confianca, distancia,
  });
  const fora = (metodo) => ({ resultado: "fora", codigo_ibge: null, metodo, confianca: "media", distancia: null });
  const pendente = (metodo, distancia = null) => ({
    resultado: "pendente", codigo_ibge: null, metodo, confianca: null, distancia,
  });
  const metodoFora = origemUf === "cep" ? "fora_cep" : "fora_uf";

  const ufTerritorio = UFS_TERRITORIO.includes(uf);
  const candidatos = porNome.get(nome) || [];

  if (candidatos.length) {
    if (ufTerritorio) {
      const certo = candidatos.find((m) => m.uf === uf);
      return certo ? municipio(certo, "exato_uf", "alta") : pendente("conflito_uf"); // "Concórdia / PR"
    }
    if (uf) return fora(metodoFora);
    if (candidatos.length === 1) return municipio(candidatos[0], "exato", "alta");
    return pendente("sem_uf"); // Palmeira, Irati… existem em PR e SC: sem UF não se decide
  }

  if (uf && !ufTerritorio) return fora(metodoFora);

  // Sem UF e o nome existe (exato) em outro estado — não é erro de digitação de PR/SC
  if (!uf && indiceBrasil().has(nome)) return fora("fora_brasil");

  // Aproximado: só com limiar alto e candidato único
  const proximos = candidatosProximos(nome, uf, 2);
  const limite = Math.min(DISTANCIA_MAXIMA, Math.floor(nome.length * 0.2));
  if (proximos.length && proximos[0].distancia <= limite &&
      (proximos.length === 1 || proximos[1].distancia > proximos[0].distancia)) {
    return municipio(proximos[0], "aproximado", "media", proximos[0].distancia);
  }
  return pendente("sem_match", proximos[0]?.distancia ?? null);
}

// Método gravado na matrícula: resolução manual carrega o resultado no nome
// ('manual' = município; 'manual_fora'; 'manual_ignorar') para o SQL da
// cobertura não precisar do apelido.
function metodoNaMatricula(apelido) {
  if (apelido.metodo !== "manual") return apelido.metodo;
  return apelido.resultado === "municipio" ? "manual" : `manual_${apelido.resultado}`;
}

// ---------- Cruzamento matrícula → município ----------

// Percorre TODAS as matrículas: chave (cidade, UF) nova vira apelido
// classificado; chave existente (automática ou manual) é reaplicada como está.
// Apelido automático cuja chave sumiu das matrículas é removido (o manual
// fica). Idempotente; roda ao fim de cada sync e após cada resolução manual.
function cruzarMunicipios() {
  const linhas = db
    .prepare("SELECT id, aluno_cidade, aluno_estado, aluno_cep FROM matriculas")
    .all();
  const apelidos = new Map(
    db.prepare("SELECT cidade_norm, uf_norm, resultado, codigo_ibge, metodo, confianca FROM municipio_apelidos")
      .all()
      .map((a) => [`${a.cidade_norm}|${a.uf_norm}`, a])
  );
  const inserir = db.prepare(
    `INSERT INTO municipio_apelidos (cidade_norm, uf_norm, resultado, codigo_ibge, metodo, confianca,
       distancia, amostra_original, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const atualizar = db.prepare(
    `UPDATE matriculas SET codigo_ibge = ?, municipio_metodo = ?, municipio_confianca = ?, aluno_uf = ?
     WHERE id = ?`
  );
  const agora = new Date().toISOString();
  const contagem = {};
  const chavesVistas = new Set();
  const ufPorCodigo = new Map(indiceMunicipios().lista.map((m) => [m.codigo, m.uf]));
  let apelidosNovos = 0;
  let apelidosRemovidos = 0;

  db.transaction(() => {
    for (const m of linhas) {
      const k = chaveDaMatricula(m);
      if (!k) {
        atualizar.run(null, "sem_cidade", null, resolverUf(m.aluno_estado, m.aluno_cep).uf, m.id);
        contagem.sem_cidade = (contagem.sem_cidade || 0) + 1;
        continue;
      }
      chavesVistas.add(k.chave);
      let apelido = apelidos.get(k.chave);
      if (!apelido) {
        const r = classificarCidade(k.nome, k.uf, k.origem);
        apelido = { cidade_norm: k.nome, uf_norm: k.uf || "", ...r };
        inserir.run(k.nome, k.uf || "", r.resultado, r.codigo_ibge, r.metodo, r.confianca, r.distancia,
          String(m.aluno_cidade ?? "").slice(0, 120), agora);
        apelidos.set(k.chave, apelido);
        apelidosNovos++;
      }
      const metodo = metodoNaMatricula(apelido);
      // UF gravada: a resolvida; para "fora_brasil" (sem UF no cadastro), a única UF
      // onde a cidade existe; para município casado, a UF do município.
      const municipioUf = apelido.resultado === "municipio"
        ? ufPorCodigo.get(apelido.codigo_ibge) ?? k.uf
        : null;
      const uf = municipioUf ?? k.uf ?? (apelido.metodo === "fora_brasil" ? ufUnicaNoBrasil(k.nome) : null);
      atualizar.run(apelido.resultado === "municipio" ? apelido.codigo_ibge : null, metodo,
        apelido.confianca, uf, m.id);
      contagem[metodo] = (contagem[metodo] || 0) + 1;
    }
    // Contatos da prospecção ativa (tabela existe desde a migração 20): UF vem
    // do upload; sufixo "/PR" no texto da cidade prevalece. Mesmos apelidos.
    const atualizarContato = db.prepare(
      "UPDATE contatos_ativo SET codigo_ibge = ?, municipio_metodo = ?, municipio_confianca = ? WHERE id = ?"
    );
    for (const c of db.prepare("SELECT id, municipio_texto, uf FROM contatos_ativo").all()) {
      const k = chaveDoContato(c);
      if (!k) {
        atualizarContato.run(null, "sem_cidade", null, c.id);
        contagem.contatos_sem_cidade = (contagem.contatos_sem_cidade || 0) + 1;
        continue;
      }
      const { nome, uf, chave } = k;
      chavesVistas.add(chave);
      let apelido = apelidos.get(chave);
      if (!apelido) {
        const r = classificarCidade(nome, uf, "texto");
        apelido = { cidade_norm: nome, uf_norm: uf || "", ...r };
        inserir.run(nome, uf || "", r.resultado, r.codigo_ibge, r.metodo, r.confianca, r.distancia,
          String(c.municipio_texto ?? "").slice(0, 120), agora);
        apelidos.set(chave, apelido);
        apelidosNovos++;
      }
      const metodo = metodoNaMatricula(apelido);
      atualizarContato.run(apelido.resultado === "municipio" ? apelido.codigo_ibge : null, metodo, apelido.confianca, c.id);
      contagem[`contatos_${metodo}`] = (contagem[`contatos_${metodo}`] || 0) + 1;
    }
    for (const [chave, a] of apelidos) {
      if (a.metodo !== "manual" && !chavesVistas.has(chave)) {
        db.prepare("DELETE FROM municipio_apelidos WHERE cidade_norm = ? AND uf_norm = ?")
          .run(a.cidade_norm, a.uf_norm);
        apelidosRemovidos++;
      }
    }
  })();

  return { matriculas: linhas.length, apelidosNovos, apelidosRemovidos, porMetodo: contagem };
}

// Migração que muda o que o cruzamento grava marca territorio_recruzar_pendente;
// o boot reprocessa uma vez e limpa a marca.
function recruzarSePendente() {
  const pendente = db
    .prepare("SELECT valor FROM configuracoes WHERE chave = 'territorio_recruzar_pendente'")
    .get()?.valor === "1";
  if (!pendente) return null;
  const r = cruzarMunicipios();
  db.prepare("DELETE FROM configuracoes WHERE chave = 'territorio_recruzar_pendente'").run();
  return r;
}

// Chaves (cidade, UF) das matrículas → { n, receita, amostras, estados, ceps }
// — para a tela de revisão saber quanto cada pendência vale e mostrar o que
// veio no cadastro (é com isso que o revisor decide).
function agruparMatriculasPorChave() {
  const grupos = new Map();
  const linhas = db
    .prepare(
      `SELECT id, aluno_cidade, aluno_estado, aluno_cep, COALESCE(valor_centavos, 0) valor,
              ${FILTRO_MATRICULA_VALIDA} valida
       FROM matriculas`
    )
    .all();
  for (const m of linhas) {
    const k = chaveDaMatricula(m);
    if (!k) continue;
    const g = grupos.get(k.chave) ?? grupos
      .set(k.chave, { n: 0, total: 0, receita: 0, amostras: new Set(), estados: new Set(), ceps: new Set() })
      .get(k.chave);
    g.total++;
    if (m.valida) {
      g.n++;
      g.receita += m.valor;
    }
    if (g.amostras.size < 3) g.amostras.add(String(m.aluno_cidade).replace(/\s+/g, " ").trim());
    if (m.aluno_estado && g.estados.size < 3) g.estados.add(String(m.aluno_estado).trim());
    if (m.aluno_cep && m.aluno_cep.length === 8 && g.ceps.size < 3) g.ceps.add(m.aluno_cep);
  }
  return grupos;
}

// ---------- Cobertura ----------

const GRUPOS_COBERTURA = [
  ["exato_uf", "Exato com UF", "nome + UF (state, CEP ou sufixo) batem com o município"],
  ["exato", "Exato sem UF", "nome único em PR+SC"],
  ["aproximado", "Aproximado", "distância de edição ≤ 2, candidato único — marcado como aproximado"],
  ["manual", "Manual", "resolvido na revisão"],
  ["fora", "Outros estados", "UF/CEP de outro estado ou cidade que só existe fora de PR/SC"],
  ["sem_cidade", "Sem cidade", "cadastro do aluno sem cidade"],
  ["ignorado", "Ignorado", "marcado na revisão para não entrar no mapa"],
  ["pendente", "Pendente", "aguardando revisão manual"],
  ["nao_processado", "Não processado", "sincronize a Unyflex para casar"],
];

const SQL_GRUPO = `CASE
  WHEN municipio_metodo IS NULL THEN 'nao_processado'
  WHEN municipio_metodo IN ('exato_uf', 'exato', 'aproximado', 'manual') THEN municipio_metodo
  WHEN municipio_metodo IN ('fora_uf', 'fora_cep', 'fora_brasil', 'manual_fora') THEN 'fora'
  WHEN municipio_metodo = 'sem_cidade' THEN 'sem_cidade'
  WHEN municipio_metodo = 'manual_ignorar' THEN 'ignorado'
  ELSE 'pendente' END`;

// Sem período = base inteira, mas no MESMO universo dos relatórios: matrícula
// sem criada_em nunca entra em período nenhum (44 na origem em 2026-09-09), então
// também fica fora daqui — e é contada à parte em `semData` para não sumir em silêncio.
function clausulaPeriodo(de, ate) {
  if (!de && !ate) return { sql: " AND criada_em IS NOT NULL", valores: [] };
  return {
    sql: " AND criada_em BETWEEN ? AND ?",
    valores: [de || "0000", (ate || "9999") + "T23:59:59"],
  };
}

const somar = (linhas) => ({
  matriculas: linhas.reduce((s, l) => s + (l.matriculas || 0), 0),
  receitaCentavos: linhas.reduce((s, l) => s + (l.receitaCentavos || 0), 0),
});
const pct = (v, t) => (t ? Math.round((v / t) * 1000) / 10 : 0);

// "Outros estados": matrículas casadas como fora de PR/SC, quebradas por UF
function outrosEstados(de, ate) {
  const periodo = clausulaPeriodo(de, ate);
  const porUf = db
    .prepare(
      `SELECT COALESCE(aluno_uf, '?') uf, COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql} AND ${SQL_GRUPO} = 'fora'
       GROUP BY 1 ORDER BY receitaCentavos DESC, matriculas DESC`
    )
    .all(...periodo.valores)
    .map((l) => ({ ...l, uf: l.uf === "?" ? null : l.uf }));
  return { ...somar(porUf), porUf };
}

function coberturaTerritorio(de, ate) {
  const periodo = clausulaPeriodo(de, ate);
  const linhas = db
    .prepare(
      `SELECT ${SQL_GRUPO} grupo, municipio_metodo metodo, COUNT(*) matriculas,
              SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql}
       GROUP BY 1, 2`
    )
    .all(...periodo.valores);
  const total = somar(linhas);
  const grupos = GRUPOS_COBERTURA.map(([grupo, rotulo, descricao]) => {
    const partes = linhas.filter((l) => l.grupo === grupo);
    const soma = somar(partes);
    return {
      grupo, rotulo, descricao, ...soma,
      pctMatriculas: pct(soma.matriculas, total.matriculas),
      pctReceita: pct(soma.receitaCentavos, total.receitaCentavos),
      metodos: partes.map((l) => ({ metodo: l.metodo, matriculas: l.matriculas, receitaCentavos: l.receitaCentavos })),
    };
  }).filter((g) => g.matriculas > 0 || ["pendente", "exato_uf", "fora"].includes(g.grupo));
  const casadas = somar(grupos.filter((g) => ["exato_uf", "exato", "aproximado", "manual"].includes(g.grupo)));
  casadas.pctMatriculas = pct(casadas.matriculas, total.matriculas);
  casadas.pctReceita = pct(casadas.receitaCentavos, total.receitaCentavos);
  const chaves = Object.fromEntries(
    db.prepare("SELECT resultado, COUNT(*) n FROM municipio_apelidos GROUP BY resultado").all()
      .map((r) => [r.resultado, r.n])
  );
  const semData = db
    .prepare(
      `SELECT COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA} AND criada_em IS NULL`
    )
    .get();
  return {
    periodo: { de: de || null, ate: ate || null }, total, casadas, grupos, chaves, semData,
    outrosEstados: outrosEstados(de, ate),
  };
}

// ---------- Revisão manual ----------

// Sugestão do sistema para cada pendência — só heurística sobre o que veio no
// cadastro; a decisão é sempre do revisor (por isso vem com o motivo).
function sugestaoParaRevisao(a, g, sugestoes) {
  const { porNome } = indiceMunicipios();
  const municipio = (s, motivo) => ({ resultado: "municipio", codigo: s.codigo, nome: s.nome, uf: s.uf, motivo });
  if (a.metodo === "aproximado" && a.municipio_nome) {
    return municipio({ codigo: a.codigo_ibge, nome: a.municipio_nome, uf: a.municipio_uf },
      `${a.distancia} letra(s) de diferença — casado automaticamente, confirme`);
  }
  // Campos trocados: o "estado" traz o município ("PR" / "Lindoeste", "barra d" / "barra do jacaré")
  for (const estado of g.estados) {
    const n = normalizarCidade(estado).nome;
    const cands = porNome.get(n) || [];
    if (cands.length === 1) return municipio(cands[0], `o campo estado do cadastro traz "${estado}"`);
  }
  const s0 = sugestoes[0];
  if (s0?.motivo === "homonimo") {
    return municipio(s0, `${s0.nome} existe só em ${s0.uf} — o estado do cadastro (${a.uf_norm || "?"}) parece errado`);
  }
  if (s0?.motivo === "contido") return municipio(s0, `o texto contém "${s0.nome}"`);
  if (s0?.motivo === "prefixo") {
    const prefixos = sugestoes.filter((s) => s.motivo === "prefixo");
    return prefixos.length === 1
      ? municipio(s0, "único município que começa com esse nome")
      : { resultado: null, motivo: `${prefixos.length} municípios começam assim (${prefixos.map((s) => s.nome).join(", ")}) — decidir pelo CEP` };
  }
  // Mesma "cidade" com CEPs de prefixos diferentes = o texto não é uma cidade
  // (instituição, sigla…) — um apelido único não resolve; tirar do mapa.
  const prefixosCep = new Set([...g.ceps].map((c) => c.slice(0, 5)));
  if (prefixosCep.size >= 2) {
    return { resultado: "ignorar", motivo: `${prefixosCep.size} CEPs de cidades diferentes com o mesmo texto — não é uma cidade` };
  }
  if (a.cidade_norm.length <= 4) return { resultado: "ignorar", motivo: "texto curto demais para ser cidade" };
  if (s0?.motivo === "proximo" && s0.distancia <= 2 && a.cidade_norm.length >= 6) {
    return municipio(s0, `${s0.distancia} letra(s) de diferença`);
  }
  const ufsBrasil = indiceBrasil().get(a.cidade_norm);
  if (ufsBrasil) return { resultado: "fora", motivo: `cidade existe em ${[...ufsBrasil].join("/")}, não em PR/SC` };
  return { resultado: null, motivo: "sem sugestão — decidir pelo CEP/estado do cadastro" };
}

// Contatos da prospecção por chave (cidade, UF) — para a revisão mostrar
// "N matrículas · M contatos" e a resolução valer para os dois
function agruparContatosPorChave() {
  const grupos = new Map();
  for (const c of db.prepare("SELECT municipio_texto, uf, setor FROM contatos_ativo").all()) {
    const k = chaveDoContato(c);
    if (!k) continue;
    const { chave } = k;
    const g = grupos.get(chave) ?? grupos.set(chave, { n: 0, amostras: new Set(), setores: new Set() }).get(chave);
    g.n++;
    if (g.amostras.size < 3) g.amostras.add(String(c.municipio_texto).replace(/\s+/g, " ").trim());
    if (g.setores.size < 4) g.setores.add(`${c.uf} · ${c.setor}`);
  }
  return grupos;
}

function pendencias() {
  const grupos = agruparMatriculasPorChave();
  const contatos = agruparContatosPorChave();
  const apelidos = db
    .prepare(
      `SELECT a.id, a.cidade_norm, a.uf_norm, a.resultado, a.codigo_ibge, a.metodo, a.confianca,
              a.distancia, a.amostra_original, m.nome AS municipio_nome, m.uf AS municipio_uf
       FROM municipio_apelidos a LEFT JOIN municipios m ON m.codigo_ibge = a.codigo_ibge
       WHERE a.resultado = 'pendente' OR a.metodo = 'aproximado'`
    )
    .all();
  const montar = (a) => {
    const g = grupos.get(`${a.cidade_norm}|${a.uf_norm}`) ||
      { n: 0, total: 0, receita: 0, amostras: new Set(), estados: new Set(), ceps: new Set() };
    const ct = contatos.get(`${a.cidade_norm}|${a.uf_norm}`) || { n: 0, amostras: new Set(), setores: new Set() };
    const sugestoes = sugerirCandidatos(a.cidade_norm, a.uf_norm, 4);
    const amostras = new Set([...g.amostras, ...ct.amostras]);
    return {
      id: a.id, cidadeNorm: a.cidade_norm, ufNorm: a.uf_norm, resultado: a.resultado, metodo: a.metodo,
      confianca: a.confianca, distancia: a.distancia,
      amostras: amostras.size ? [...amostras].slice(0, 3) : [a.amostra_original],
      estados: [...g.estados], ceps: [...g.ceps],
      matriculas: g.n, matriculasTotal: g.total, receitaCentavos: g.receita,
      contatos: ct.n, contatosSetores: [...ct.setores],
      municipio: a.codigo_ibge ? { codigo: a.codigo_ibge, nome: a.municipio_nome, uf: a.municipio_uf } : null,
      sugestoes,
      sugestao: sugestaoParaRevisao(a, g, sugestoes),
    };
  };
  const ordenar = (x, y) => y.receitaCentavos - x.receitaCentavos || y.matriculasTotal - x.matriculasTotal;
  return {
    pendentes: apelidos.filter((a) => a.resultado === "pendente").map(montar).sort(ordenar),
    aproximados: apelidos.filter((a) => a.metodo === "aproximado").map(montar).sort(ordenar),
  };
}

function erroValidacao(mensagem) {
  const err = new Error(mensagem);
  err.validacao = true;
  return err;
}

function validarResolucao({ cidadeNorm, ufNorm, resultado, codigoIbge }) {
  const cidade = String(cidadeNorm || "").trim();
  const uf = String(ufNorm || "").trim();
  if (!cidade) throw erroValidacao("cidadeNorm é obrigatório.");
  if (!["municipio", "fora", "ignorar"].includes(resultado)) {
    throw erroValidacao(`"${cidade}": resultado deve ser municipio, fora ou ignorar.`);
  }
  let codigo = null;
  if (resultado === "municipio") {
    codigo = Number(codigoIbge);
    if (!Number.isInteger(codigo) || !db.prepare("SELECT 1 FROM municipios WHERE codigo_ibge = ?").get(codigo)) {
      throw erroValidacao(`"${cidade}": codigoIbge não corresponde a um município de PR/SC.`);
    }
  }
  return { cidade, uf, resultado, codigo };
}

const gravarApelidoManual = db.prepare(
  `INSERT INTO municipio_apelidos (cidade_norm, uf_norm, resultado, codigo_ibge, metodo, confianca,
     distancia, amostra_original, criado_em, usuario_id)
   VALUES (?, ?, ?, ?, 'manual', 'manual', NULL, ?, ?, ?)
   ON CONFLICT(cidade_norm, uf_norm) DO UPDATE SET resultado = excluded.resultado,
     codigo_ibge = excluded.codigo_ibge, metodo = 'manual', confianca = 'manual', distancia = NULL,
     criado_em = excluded.criado_em, usuario_id = excluded.usuario_id`
);

function resolverApelidosLote(itens, usuarioId) {
  if (!Array.isArray(itens) || !itens.length) throw erroValidacao("Nenhum item para resolver.");
  const validos = itens.map(validarResolucao); // valida TUDO antes de gravar qualquer um
  const agora = new Date().toISOString();
  return db.transaction(() => {
    for (const v of validos) {
      const existente = db
        .prepare("SELECT amostra_original FROM municipio_apelidos WHERE cidade_norm = ? AND uf_norm = ?")
        .get(v.cidade, v.uf);
      gravarApelidoManual.run(v.cidade, v.uf, v.resultado, v.codigo,
        existente?.amostra_original ?? v.cidade, agora, usuarioId);
    }
    return cruzarMunicipios();
  })();
}

const resolverApelido = (item, usuarioId) => resolverApelidosLote([item], usuarioId);

// ---------- Agregação por estado / regional / município (Fase 2) ----------

const SQL_ALUNO_DISTINTO = "COUNT(DISTINCT COALESCE(student_id, 'm' || id))";

// Devolve estados, regionais (só pela regional PRINCIPAL), municípios (todos
// os 694, com zero e temHistorico), outros estados por UF, "sem município" por
// grupo, total e a conferência da cadeia municípios = regionais = estados;
// estados + outros estados + sem município = total = calcularMetricas().empresa.
function agregarTerritorio(de, ate) {
  const periodo = clausulaPeriodo(de, ate);
  const base = `FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql}`;

  const porMunicipio = new Map(
    db.prepare(
      `SELECT codigo_ibge codigo, COUNT(*) matriculas, ${SQL_ALUNO_DISTINTO} alunos,
              SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       ${base} AND codigo_ibge IS NOT NULL GROUP BY 1`
    ).all(...periodo.valores).map((l) => [l.codigo, l])
  );
  const comHistorico = new Set(
    db.prepare(`SELECT DISTINCT codigo_ibge FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA} AND codigo_ibge IS NOT NULL`)
      .all().map((l) => l.codigo_ibge)
  );
  const { regionais: listaRegionais, municipios: listaMunicipios } = listarMunicipiosERegionais();

  const municipios = listaMunicipios.map((m) => {
    const v = porMunicipio.get(m.codigo) || { matriculas: 0, alunos: 0, receitaCentavos: 0 };
    return {
      codigo: m.codigo, uf: m.uf, nome: m.nome, regionalPrincipalId: m.regionalPrincipalId,
      regionais: m.regionais, matriculas: v.matriculas, alunos: v.alunos, receitaCentavos: v.receitaCentavos,
      temHistorico: comHistorico.has(m.codigo),
    };
  });

  // Alunos distintos por regional e por estado precisam de SQL próprio (não são aditivos)
  const alunosPorRegional = new Map(
    db.prepare(
      `SELECT mu.regional_principal_id id, ${SQL_ALUNO_DISTINTO} alunos
       FROM matriculas JOIN municipios mu ON mu.codigo_ibge = matriculas.codigo_ibge
       WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql} GROUP BY 1`
    ).all(...periodo.valores).map((l) => [l.id, l.alunos])
  );
  const alunosPorUf = new Map(
    db.prepare(
      `SELECT mu.uf, ${SQL_ALUNO_DISTINTO} alunos
       FROM matriculas JOIN municipios mu ON mu.codigo_ibge = matriculas.codigo_ibge
       WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql} GROUP BY 1`
    ).all(...periodo.valores).map((l) => [l.uf, l.alunos])
  );

  const regionais = listaRegionais.map((r) => {
    const proprios = municipios.filter((m) => m.regionalPrincipalId === r.id);
    const compartilhados = municipios.filter((m) => m.regionalPrincipalId !== r.id && m.regionais.includes(r.id));
    const porId = new Map(listaRegionais.map((x) => [x.id, x]));
    return {
      id: r.id, uf: r.uf, sigla: r.sigla, nome: r.nome, cidadePolo: r.cidadePolo,
      ...somar(proprios), alunos: alunosPorRegional.get(r.id) || 0,
      municipios: proprios.length, municipiosComDado: proprios.filter((m) => m.matriculas > 0).length,
      compartilhados: {
        ...somar(compartilhados),
        municipios: compartilhados.map((m) => ({
          codigo: m.codigo, nome: m.nome, matriculas: m.matriculas, receitaCentavos: m.receitaCentavos,
          contadoEm: porId.get(m.regionalPrincipalId)?.sigla ?? null,
        })),
      },
    };
  });

  const estados = UFS_TERRITORIO.map((uf) => {
    const proprios = municipios.filter((m) => m.uf === uf);
    return {
      uf, ...somar(proprios), alunos: alunosPorUf.get(uf) || 0,
      regionais: regionais.filter((r) => r.uf === uf).length,
      municipiosComDado: proprios.filter((m) => m.matriculas > 0).length,
    };
  });

  const fora = outrosEstados(de, ate);
  const semMunicipioLinhas = db
    .prepare(
      `SELECT ${SQL_GRUPO} grupo, COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       ${base} AND ${SQL_GRUPO} IN ('sem_cidade', 'pendente', 'ignorado', 'nao_processado') GROUP BY 1`
    )
    .all(...periodo.valores);
  const semMunicipio = { ...somar(semMunicipioLinhas), porGrupo: semMunicipioLinhas };
  const total = db
    .prepare(`SELECT COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receitaCentavos ${base}`)
    .get(...periodo.valores);
  total.receitaCentavos = total.receitaCentavos || 0;

  // Município sem regional principal (só acontece se o CSV não cobrir o IBGE)
  const semRegional = somar(municipios.filter((m) => !m.regionalPrincipalId));

  // Conferência: cada elo da cadeia, com os dois lados e a diferença
  const somaMunicipios = somar(municipios);
  const somaRegionais = somar(regionais);
  const somaEstados = somar(estados);
  const soma3 = somar([somaEstados, fora, semMunicipio]);
  // Contra o motor de métricas: com período, o mesmo; sem período, min/max de criada_em
  const janela = de && ate ? { de, ate } : db
    .prepare("SELECT substr(MIN(criada_em), 1, 10) de, substr(MAX(criada_em), 1, 10) ate FROM matriculas WHERE criada_em IS NOT NULL")
    .get();
  const empresa = janela.de && janela.ate ? calcularMetricas(janela.de, janela.ate).empresa : null;
  const elo = (rotulo, a, b) => ({
    rotulo, a, b,
    bate: a.matriculas === b.matriculas && a.receitaCentavos === b.receitaCentavos,
    diferenca: { matriculas: a.matriculas - b.matriculas, receitaCentavos: a.receitaCentavos - b.receitaCentavos },
  });
  const elos = [
    elo("Σ municípios = Σ regionais", somaMunicipios, somar([somaRegionais, semRegional])),
    elo("Σ regionais = Σ estados", somar([somaRegionais, semRegional]), somaEstados),
    elo("Σ estados + outros estados + sem município = total do período", soma3, total),
  ];
  if (empresa) {
    elos.push(elo(`total do período = /api/metricas empresa (${janela.de} a ${janela.ate})`, total,
      { matriculas: empresa.matriculas, receitaCentavos: empresa.receitaCentavos }));
  }
  const conferencia = { bate: elos.every((e) => e.bate), elos, janelaMetricas: janela, semRegional };

  return {
    periodo: { de: de || null, ate: ate || null },
    estados, regionais, municipios, outrosEstados: fora, semMunicipio, total, conferencia,
    calculadoEm: new Date().toISOString(),
  };
}

// Detalhe de um município: resumo, cursos, vendedores (carteira) e alunos
function detalheMunicipio(codigoIbge, de, ate) {
  const codigo = Number(codigoIbge);
  const municipio = db
    .prepare(
      `SELECT m.codigo_ibge codigo, m.uf, m.nome, m.regional_principal_id regionalPrincipalId,
              r.sigla regionalSigla, r.nome regionalNome
       FROM municipios m LEFT JOIN regionais r ON r.id = m.regional_principal_id
       WHERE m.codigo_ibge = ?`
    )
    .get(codigo);
  if (!municipio) return null;
  const outrasRegionais = db
    .prepare(
      `SELECT r.id, r.sigla, r.nome FROM regional_municipios rm JOIN regionais r ON r.id = rm.regional_id
       WHERE rm.codigo_ibge = ? AND r.id != COALESCE(?, -1) ORDER BY rm.ordem`
    )
    .all(codigo, municipio.regionalPrincipalId);

  const periodo = clausulaPeriodo(de, ate);
  const base = `FROM matriculas m WHERE m.codigo_ibge = ? AND ${FILTRO_MATRICULA_VALIDA.replace(/status/g, "m.status")}${periodo.sql.replace("criada_em", "m.criada_em")}`;
  const valores = [codigo, ...periodo.valores];

  const resumo = db
    .prepare(
      `SELECT COUNT(*) matriculas, COUNT(DISTINCT COALESCE(m.student_id, 'm' || m.id)) alunos,
              SUM(COALESCE(m.valor_centavos, 0)) receitaCentavos,
              MIN(m.criada_em) primeira, MAX(m.criada_em) ultima ${base}`
    )
    .get(...valores);
  resumo.receitaCentavos = resumo.receitaCentavos || 0;
  resumo.ticketMedioCentavos = resumo.matriculas ? Math.round(resumo.receitaCentavos / resumo.matriculas) : null;
  resumo.canceladas = db
    .prepare(`SELECT COUNT(*) n FROM matriculas m WHERE m.codigo_ibge = ? AND m.status = 'canceled'${periodo.sql.replace("criada_em", "m.criada_em")}`)
    .get(...valores).n;

  const cursos = db
    .prepare(
      `SELECT t.nome curso, COUNT(DISTINCT t.id) turmas, COUNT(*) matriculas,
              COUNT(DISTINCT COALESCE(m.student_id, 'm' || m.id)) alunos,
              SUM(COALESCE(m.valor_centavos, 0)) receitaCentavos
       ${base.replace("FROM matriculas m", "FROM matriculas m JOIN turmas t ON t.id = m.turma_id")}
       GROUP BY t.nome ORDER BY receitaCentavos DESC, matriculas DESC`
    )
    .all(...valores);

  const vendedores = db
    .prepare(
      `SELECT COALESCE(p.nome, 'Sem atribuição') vendedor, p.tipo, COUNT(*) matriculas,
              COUNT(DISTINCT COALESCE(m.student_id, 'm' || m.id)) alunos,
              SUM(COALESCE(m.valor_centavos, 0)) receitaCentavos, MAX(m.criada_em) ultima
       ${base.replace("FROM matriculas m", "FROM matriculas m LEFT JOIN pessoas p ON p.id = m.pessoa_id")}
       GROUP BY m.pessoa_id ORDER BY receitaCentavos DESC, matriculas DESC`
    )
    .all(...valores);

  const matriculas = db
    .prepare(
      `SELECT m.id, m.aluno_nome aluno, m.aluno_cidade cidadeCadastro, t.nome curso, t.subtitulo turma,
              COALESCE(p.nome, 'Sem atribuição') vendedor, m.valor_centavos valorCentavos, m.criada_em criadaEm,
              m.status, m.municipio_metodo metodo
       ${base.replace("FROM matriculas m", "FROM matriculas m LEFT JOIN turmas t ON t.id = m.turma_id LEFT JOIN pessoas p ON p.id = m.pessoa_id")}
       ORDER BY m.criada_em DESC`
    )
    .all(...valores);

  const temHistorico = Boolean(
    db.prepare(`SELECT 1 FROM matriculas WHERE codigo_ibge = ? AND ${FILTRO_MATRICULA_VALIDA} LIMIT 1`).get(codigo)
  );

  return {
    periodo: { de: de || null, ate: ate || null },
    municipio: { ...municipio, outrasRegionais },
    resumo, cursos, vendedores, matriculas, temHistorico,
    prospeccao: contextoProspeccao(municipio, de, ate),
  };
}

// Argumento de venda pronto: a regional do município no período (receita e
// quantos municípios dela já compraram) e os vizinhos geográficos que já são
// clientes (histórico completo, independente do período) com o que fizeram no
// período. "Cliente" = alguma matrícula válida em qualquer data.
function contextoProspeccao(municipio, de, ate) {
  const periodo = clausulaPeriodo(de, ate);
  const noPeriodo = new Map(
    db.prepare(
      `SELECT codigo_ibge codigo, COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receitaCentavos
       FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA}${periodo.sql} AND codigo_ibge IS NOT NULL GROUP BY 1`
    ).all(...periodo.valores).map((l) => [l.codigo, l])
  );
  const clientes = new Set(
    db.prepare(`SELECT DISTINCT codigo_ibge FROM matriculas WHERE ${FILTRO_MATRICULA_VALIDA} AND codigo_ibge IS NOT NULL`)
      .all().map((l) => l.codigo_ibge)
  );
  const linha = (m) => {
    const v = noPeriodo.get(m.codigo) || { matriculas: 0, receitaCentavos: 0 };
    return { codigo: m.codigo, nome: m.nome, uf: m.uf, cliente: clientes.has(m.codigo), matriculas: v.matriculas, receitaCentavos: v.receitaCentavos };
  };

  let regional = null;
  if (municipio.regionalPrincipalId) {
    const daRegional = db
      .prepare("SELECT codigo_ibge codigo, nome, uf FROM municipios WHERE regional_principal_id = ? ORDER BY nome")
      .all(municipio.regionalPrincipalId)
      .map(linha);
    regional = {
      id: municipio.regionalPrincipalId, sigla: municipio.regionalSigla, nome: municipio.regionalNome,
      ...somar(daRegional), municipios: daRegional.length,
      clientes: daRegional.filter((m) => m.cliente).length,
      semCompra: daRegional.filter((m) => !m.cliente).map(({ codigo, nome }) => ({ codigo, nome })),
    };
  }

  const codigosVizinhos = indiceVizinhos().get(municipio.codigo) || [];
  const lista = codigosVizinhos.length
    ? db.prepare(
        `SELECT codigo_ibge codigo, nome, uf FROM municipios
         WHERE codigo_ibge IN (${codigosVizinhos.map(() => "?").join(",")}) ORDER BY nome`
      ).all(...codigosVizinhos).map(linha)
    : [];
  lista.sort((a, b) => b.cliente - a.cliente || b.receitaCentavos - a.receitaCentavos || a.nome.localeCompare(b.nome));
  const vizinhos = { total: lista.length, clientes: lista.filter((m) => m.cliente).length, ...somar(lista), lista };
  return { regional, vizinhos };
}

// ---------- Referência: regionais e municípios ----------

// Roda em todo boot (idempotente). Municípios vêm do JSON do IBGE; regionais e
// vínculos, do CSV do usuário. Linha do CSV cujo município não existe no IBGE
// = referência inconsistente → erro fatal (não pode passar em silêncio). CSV
// ausente = aviso alto, app sobe sem regionais.
function carregarReferencias() {
  const resumo = { municipios: 0, regionais: 0, vinculos: 0, vinculosRemovidos: 0,
    compartilhados: 0, principaisDefinidas: 0, csv: false, avisos: [] };

  const municipios = JSON.parse(fs.readFileSync(ARQ_MUNICIPIOS_PR_SC, "utf8"));
  const upsertMunicipio = db.prepare(
    `INSERT INTO municipios (codigo_ibge, uf, nome, nome_normalizado) VALUES (?, ?, ?, ?)
     ON CONFLICT(codigo_ibge) DO UPDATE SET uf = excluded.uf, nome = excluded.nome,
       nome_normalizado = excluded.nome_normalizado`
  );

  let linhasCsv = null;
  if (fs.existsSync(ARQ_CSV_REGIONAIS)) {
    linhasCsv = lerCsv(removerBom(fs.readFileSync(ARQ_CSV_REGIONAIS, "utf8")));
    resumo.csv = true;
  } else {
    resumo.avisos.push(`arquivo ${path.relative(__dirname, ARQ_CSV_REGIONAIS)} não encontrado — regionais não carregadas.`);
  }

  db.transaction(() => {
    for (const m of municipios) {
      upsertMunicipio.run(m.codigo, m.uf, m.nome, normalizarCidade(m.nome).nome);
    }
    resumo.municipios = municipios.length;
    invalidarIndice();
    if (!linhasCsv) return;

    const { porNome } = indiceMunicipios();
    const upsertRegional = db.prepare(
      `INSERT INTO regionais (uf, sigla, nome, cidade_polo) VALUES (?, ?, ?, ?)
       ON CONFLICT(uf, sigla) DO UPDATE SET nome = excluded.nome, cidade_polo = excluded.cidade_polo`
    );
    const idRegional = db.prepare("SELECT id FROM regionais WHERE uf = ? AND sigla = ?");
    const upsertVinculo = db.prepare(
      `INSERT INTO regional_municipios (regional_id, codigo_ibge, ordem) VALUES (?, ?, ?)
       ON CONFLICT(regional_id, codigo_ibge) DO UPDATE SET ordem = excluded.ordem`
    );
    const vinculosCsv = new Set();
    const regionaisCsv = new Set();
    linhasCsv.forEach((linha, i) => {
      const uf = String(linha.uf || "").trim().toUpperCase();
      const sigla = String(linha.sigla_regional || "").trim();
      const nomeMunicipio = String(linha.municipio || "").trim();
      if (!uf || !sigla || !nomeMunicipio) {
        throw new Error(`regionais CSV, linha ${i + 2}: uf, sigla_regional e municipio são obrigatórios.`);
      }
      const candidato = (porNome.get(normalizarCidade(nomeMunicipio).nome) || []).find((m) => m.uf === uf);
      if (!candidato) {
        throw new Error(`regionais CSV, linha ${i + 2}: município "${nomeMunicipio}" (${uf}) não existe no IBGE — corrija o arquivo.`);
      }
      upsertRegional.run(uf, sigla, String(linha.nome_regional || "").trim() || null,
        String(linha.cidade_polo || "").trim() || null);
      const regionalId = idRegional.get(uf, sigla).id;
      regionaisCsv.add(regionalId);
      upsertVinculo.run(regionalId, candidato.codigo, i + 1);
      vinculosCsv.add(`${regionalId}|${candidato.codigo}`);
    });

    for (const v of db.prepare("SELECT regional_id, codigo_ibge FROM regional_municipios").all()) {
      if (!vinculosCsv.has(`${v.regional_id}|${v.codigo_ibge}`)) {
        db.prepare("DELETE FROM regional_municipios WHERE regional_id = ? AND codigo_ibge = ?")
          .run(v.regional_id, v.codigo_ibge);
        resumo.vinculosRemovidos++;
      }
    }
    // Principal: só onde ainda não há, ou onde a atual deixou de ser vínculo
    resumo.principaisDefinidas = db.prepare(
      `UPDATE municipios SET regional_principal_id = (
         SELECT regional_id FROM regional_municipios rm
         WHERE rm.codigo_ibge = municipios.codigo_ibge ORDER BY rm.ordem LIMIT 1)
       WHERE regional_principal_id IS NULL
          OR regional_principal_id NOT IN (
            SELECT regional_id FROM regional_municipios rm WHERE rm.codigo_ibge = municipios.codigo_ibge)`
    ).run().changes;
    resumo.regionais = regionaisCsv.size;
    resumo.vinculos = vinculosCsv.size;
    resumo.compartilhados = db
      .prepare("SELECT COUNT(*) n FROM (SELECT codigo_ibge FROM regional_municipios GROUP BY 1 HAVING COUNT(*) > 1)")
      .get().n;
    const semRegional = db
      .prepare("SELECT COUNT(*) n FROM municipios WHERE regional_principal_id IS NULL")
      .get().n;
    if (semRegional) resumo.avisos.push(`${semRegional} município(s) do IBGE sem regional no CSV.`);
  })();

  invalidarIndice();
  return resumo;
}

function listarMunicipiosERegionais() {
  const regionais = db
    .prepare(
      `SELECT r.id, r.uf, r.sigla, r.nome, r.cidade_polo AS cidadePolo,
              (SELECT COUNT(*) FROM municipios m WHERE m.regional_principal_id = r.id) AS municipios,
              (SELECT COUNT(*) FROM regional_municipios rm WHERE rm.regional_id = r.id) AS vinculos
       FROM regionais r ORDER BY r.uf, r.sigla`
    )
    .all();
  const vinculos = new Map();
  for (const v of db.prepare("SELECT regional_id, codigo_ibge FROM regional_municipios ORDER BY ordem").all()) {
    (vinculos.get(v.codigo_ibge) ?? vinculos.set(v.codigo_ibge, []).get(v.codigo_ibge)).push(v.regional_id);
  }
  const municipios = db
    .prepare("SELECT codigo_ibge AS codigo, uf, nome, regional_principal_id AS regionalPrincipalId FROM municipios ORDER BY uf, nome")
    .all()
    .map((m) => ({ ...m, regionais: vinculos.get(m.codigo) || [] }));
  return { regionais, municipios };
}

function compartilhados() {
  const { regionais, municipios } = listarMunicipiosERegionais();
  const porId = new Map(regionais.map((r) => [r.id, r]));
  return municipios
    .filter((m) => m.regionais.length > 1)
    .map((m) => ({
      ...m,
      opcoes: m.regionais.map((id) => ({ id, sigla: porId.get(id)?.sigla, nome: porId.get(id)?.nome })),
    }));
}

function definirRegionalPrincipal(codigoIbge, regionalId) {
  const codigo = Number(codigoIbge);
  const regional = Number(regionalId);
  const vinculo = db
    .prepare("SELECT 1 FROM regional_municipios WHERE codigo_ibge = ? AND regional_id = ?")
    .get(codigo, regional);
  if (!vinculo) throw erroValidacao("A regional informada não está vinculada a esse município no CSV.");
  db.prepare("UPDATE municipios SET regional_principal_id = ? WHERE codigo_ibge = ?").run(regional, codigo);
  invalidarIndice();
}

function lerMapaSvg() {
  return fs.existsSync(ARQ_MAPA) ? fs.readFileSync(ARQ_MAPA, "utf8") : null;
}

module.exports = {
  carregarReferencias,
  cruzarMunicipios,
  recruzarSePendente,
  coberturaTerritorio,
  pendencias,
  resolverApelido,
  resolverApelidosLote,
  agregarTerritorio,
  detalheMunicipio,
  listarMunicipiosERegionais,
  compartilhados,
  definirRegionalPrincipal,
  lerMapaSvg,
  // utilitários (testes e prospeccao.js)
  normalizarCidade,
  normalizarUf,
  resolverUf,
  classificarCidade,
  sugerirCandidatos,
  indiceMunicipios,
  levenshtein,
  FILTRO_MATRICULA_VALIDA,
};
