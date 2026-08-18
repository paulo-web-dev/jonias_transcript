"use strict";

// Motor de métricas da Etapa 2 — SQL puro sobre a cópia local (better-sqlite3).
// NENHUM número daqui passa por modelo de linguagem: a futura camada de IA
// consome estas métricas prontas, nunca as produz.
//
// Convenções (decisões do usuário):
// - Denominador de meta = DIAS ÚTEIS (seg–sex) do período. Sem feriados nesta
//   etapa (limitação documentada no CLAUDE.md).
// - "Discadas" (esforço, meta 45/dia) ≠ "atendidas" (qualidade da lista);
//   ligação "só Encerrada" conta como discada.
// - TMA usa sempre tempo_conversa_seg — nunca duracao_seg (que inclui toque).
// - Matrículas ≠ vendas (oportunidades conquistadas) ≠ receita: três métricas
//   distintas, sempre lado a lado.
// - Perdidas no período: COALESCE(fase_06_em, atualizado_em); as que usaram
//   atualizado_em são contadas como "aproximadas" (sinalizadas na tela).
// - Conflito de atribuição (wallet ≠ vendedor da oportunidade): vale o wallet,
//   mas o conflito é contado e exposto.
// - Pessoas tipo 'canal' (Unyflex) entram nos totais da empresa, nunca em
//   ranking, metas ou feedback.

const db = require("./db.js");

// Dias úteis (seg–sex) entre duas datas "YYYY-MM-DD", inclusivo
function diasUteis(de, ate) {
  const inicio = new Date(de + "T00:00:00Z");
  const fim = new Date(ate + "T00:00:00Z");
  if (isNaN(inicio) || isNaN(fim) || fim < inicio) return 0;
  let n = 0;
  for (let d = new Date(inicio); d <= fim; d.setUTCDate(d.getUTCDate() + 1)) {
    const dia = d.getUTCDay();
    if (dia >= 1 && dia <= 5) n++;
  }
  return n;
}

// Metas vigentes no período: padrão (pessoa_id NULL) + overrides por pessoa.
// Se houver mais de uma vigência sobreposta, vale a de vigente_desde mais
// recente.
function metasVigentes(de, ate) {
  const linhas = db
    .prepare(
      `SELECT pessoa_id, indicador, valor FROM metas
       WHERE vigente_desde <= ? AND (vigente_ate IS NULL OR vigente_ate >= ?)
       ORDER BY vigente_desde ASC`
    )
    .all(ate, de);
  const padrao = {};
  const porPessoa = {};
  for (const m of linhas) {
    if (m.pessoa_id === null) padrao[m.indicador] = m.valor;
    else ((porPessoa[m.pessoa_id] ??= {})[m.indicador] = m.valor);
  }
  return { padrao, porPessoa };
}

const mediana = (valores) => {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

const pct = (valor, meta) => (meta > 0 ? Math.round((1000 * valor) / meta) / 10 : null);

function porPessoaId(linhas) {
  return new Map(linhas.map((l) => [l.pessoa_id, l]));
}

function calcularMetricas(de, ate) {
  const fim = ate + "T23:59:59";
  const nDiasUteis = diasUteis(de, ate);
  const metas = metasVigentes(de, ate);
  const consultores = db
    .prepare("SELECT id, nome FROM pessoas WHERE tipo = 'consultor' AND ativo = 1 ORDER BY nome")
    .all();

  const ligacoes = porPessoaId(db.prepare(
    `SELECT pessoa_id, COUNT(*) discadas, SUM(atendida) atendidas,
            SUM(COALESCE(tempo_conversa_seg, 0)) conversa_seg
     FROM ligacoes WHERE data_hora BETWEEN ? AND ? AND pessoa_id IS NOT NULL
     GROUP BY pessoa_id`).all(de, fim));
  const toques = db.prepare(
    `SELECT pessoa_id, tempo_toque_seg FROM ligacoes
     WHERE data_hora BETWEEN ? AND ? AND pessoa_id IS NOT NULL AND tempo_toque_seg IS NOT NULL`
  ).all(de, fim);
  const toquesPorPessoa = new Map();
  for (const t of toques) {
    (toquesPorPessoa.get(t.pessoa_id) ?? toquesPorPessoa.set(t.pessoa_id, []).get(t.pessoa_id))
      .push(t.tempo_toque_seg);
  }

  const leads = porPessoaId(db.prepare(
    `SELECT pessoa_id, COUNT(*) n FROM oportunidades
     WHERE fase_01_em BETWEEN ? AND ? AND pessoa_id IS NOT NULL GROUP BY pessoa_id`).all(de, fim));
  const funil = db.prepare(
    `SELECT pessoa_id, fase_atual, COUNT(*) n FROM oportunidades
     WHERE fase_01_em BETWEEN ? AND ? AND pessoa_id IS NOT NULL
     GROUP BY pessoa_id, fase_atual`).all(de, fim);
  const funilPorPessoa = new Map();
  for (const f of funil) {
    (funilPorPessoa.get(f.pessoa_id) ?? funilPorPessoa.set(f.pessoa_id, {}).get(f.pessoa_id))[
      f.fase_atual || "(sem fase)"] = f.n;
  }
  const perdidas = porPessoaId(db.prepare(
    `SELECT pessoa_id, COUNT(*) n, SUM(fase_06_em IS NULL) aproximadas FROM oportunidades
     WHERE status = 'Perdido' AND COALESCE(fase_06_em, atualizado_em) BETWEEN ? AND ?
       AND pessoa_id IS NOT NULL GROUP BY pessoa_id`).all(de, fim));
  const conquistadas = porPessoaId(db.prepare(
    `SELECT pessoa_id, COUNT(*) n, SUM(COALESCE(ticket_centavos, 0)) ticket_centavos
     FROM oportunidades
     WHERE status = 'Conquistado' AND fase_06_em BETWEEN ? AND ? AND pessoa_id IS NOT NULL
     GROUP BY pessoa_id`).all(de, fim));

  const filtroMatricula =
    `criada_em BETWEEN ? AND ? AND (status IS NULL OR status != 'canceled')`;
  const matriculas = porPessoaId(db.prepare(
    `SELECT pessoa_id, COUNT(*) n, SUM(COALESCE(valor_centavos, 0)) receita_centavos
     FROM matriculas WHERE ${filtroMatricula} AND pessoa_id IS NOT NULL
     GROUP BY pessoa_id`).all(de, fim));
  const conflitos = porPessoaId(db.prepare(
    `SELECT m.pessoa_id, COUNT(*) n FROM matriculas m
     JOIN oportunidades o ON o.id = m.oportunidade_id
     WHERE m.criada_em BETWEEN ? AND ? AND m.pessoa_id IS NOT NULL
       AND o.pessoa_id IS NOT NULL AND m.pessoa_id != o.pessoa_id
     GROUP BY m.pessoa_id`).all(de, fim));

  const comMeta = (valor, metaDia) => ({
    valor,
    metaDia: metaDia ?? null,
    meta: metaDia != null ? Math.round(metaDia * nDiasUteis * 10) / 10 : null,
    atingimento: metaDia != null ? pct(valor, metaDia * nDiasUteis) : null,
  });

  const porPessoa = consultores.map((p) => {
    const metaDe = (ind) => metas.porPessoa[p.id]?.[ind] ?? metas.padrao[ind] ?? null;
    const l = ligacoes.get(p.id) || { discadas: 0, atendidas: 0, conversa_seg: 0 };
    const perd = perdidas.get(p.id) || { n: 0, aproximadas: 0 };
    const conq = conquistadas.get(p.id) || { n: 0, ticket_centavos: 0 };
    const mat = matriculas.get(p.id) || { n: 0, receita_centavos: 0 };
    return {
      pessoaId: p.id,
      nome: p.nome,
      ligacoes: {
        discadas: comMeta(l.discadas, metaDe("ligacoes_dia")),
        atendidas: l.atendidas || 0,
        taxaAtendimento: l.discadas ? pct(l.atendidas || 0, l.discadas) : null,
        conversaSeg: l.conversa_seg || 0,
        tmaSeg: l.atendidas ? Math.round(l.conversa_seg / l.atendidas) : null,
        toqueMedianoSeg: mediana(toquesPorPessoa.get(p.id) || []),
      },
      funil: {
        leadsNovos: comMeta(leads.get(p.id)?.n || 0, metaDe("leads_dia")),
        porFase: funilPorPessoa.get(p.id) || {},
        perdidas: perd.n,
        perdidasAproximadas: perd.aproximadas || 0,
        vendas: conq.n,
        ticketCentavos: conq.ticket_centavos,
      },
      matriculas: comMeta(mat.n, metaDe("matriculas_dia")),
      receitaCentavos: mat.receita_centavos,
      conflitosAtribuicao: conflitos.get(p.id)?.n || 0,
    };
  });

  // Agregado dos consultores (metas do time = soma das metas individuais)
  const soma = (fn) => porPessoa.reduce((s, p) => s + fn(p), 0);
  const equipe = {
    discadas: soma((p) => p.ligacoes.discadas.valor),
    metaDiscadas: soma((p) => p.ligacoes.discadas.meta || 0),
    atendidas: soma((p) => p.ligacoes.atendidas),
    conversaSeg: soma((p) => p.ligacoes.conversaSeg),
    leadsNovos: soma((p) => p.funil.leadsNovos.valor),
    metaLeads: soma((p) => p.funil.leadsNovos.meta || 0),
    perdidas: soma((p) => p.funil.perdidas),
    vendas: soma((p) => p.funil.vendas),
    matriculas: soma((p) => p.matriculas.valor),
    metaMatriculas: Math.round(soma((p) => p.matriculas.meta || 0) * 10) / 10,
    receitaCentavos: soma((p) => p.receitaCentavos),
  };
  equipe.taxaAtendimento = equipe.discadas ? pct(equipe.atendidas, equipe.discadas) : null;
  equipe.tmaSeg = equipe.atendidas ? Math.round(equipe.conversaSeg / equipe.atendidas) : null;

  // Canais (ex.: Unyflex) e sem atribuição: fecham os totais da empresa,
  // fora de ranking e metas
  const canais = db.prepare(
    `SELECT p.nome, COUNT(*) matriculas, SUM(COALESCE(m.valor_centavos, 0)) receita_centavos
     FROM matriculas m JOIN pessoas p ON p.id = m.pessoa_id AND p.tipo = 'canal'
     WHERE m.criada_em BETWEEN ? AND ? AND (m.status IS NULL OR m.status != 'canceled')
     GROUP BY p.nome`).all(de, fim);
  const semAtribuicao = db.prepare(
    `SELECT COUNT(*) matriculas, SUM(COALESCE(valor_centavos, 0)) receita_centavos
     FROM matriculas WHERE ${filtroMatricula} AND pessoa_id IS NULL`).get(de, fim);

  const empresa = {
    matriculas: equipe.matriculas +
      canais.reduce((s, c) => s + c.matriculas, 0) + (semAtribuicao.matriculas || 0),
    receitaCentavos: equipe.receitaCentavos +
      canais.reduce((s, c) => s + (c.receita_centavos || 0), 0) +
      (semAtribuicao.receita_centavos || 0),
  };

  return {
    de,
    ate,
    diasUteis: nDiasUteis,
    calculadoEm: new Date().toISOString(),
    porPessoa,
    equipe,
    canais,
    semAtribuicao: {
      matriculas: semAtribuicao.matriculas || 0,
      receitaCentavos: semAtribuicao.receita_centavos || 0,
    },
    empresa,
  };
}

// ---------- Saúde dos dados ----------
// Tão importante quanto as métricas: se o painel da TV mostrar número errado
// por dado faltando, isto aqui mostra antes.
function saudeDosDados() {
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  const ultimaImportacao = (tipo) =>
    um(`SELECT id, arquivo_nome, concluido_em FROM importacoes
        WHERE tipo = ? AND status = 'concluida' ORDER BY id DESC LIMIT 1`, tipo) || null;

  const janelaOmie = um("SELECT MIN(incluido_em) de, MAX(incluido_em) ate FROM oportunidades");

  return {
    geradoEm: new Date().toISOString(),
    fontes: {
      cdr: {
        ultimaImportacao: ultimaImportacao("cdr"),
        dadosAte: um("SELECT MAX(data_hora) v FROM ligacoes").v,
        registros: um("SELECT COUNT(*) n FROM ligacoes").n,
      },
      omie: {
        ultimaImportacao: ultimaImportacao("oportunidades"),
        dadosAte: janelaOmie.ate,
        registros: um("SELECT COUNT(*) n FROM oportunidades").n,
      },
      mysql: {
        ultimaImportacao: ultimaImportacao("mysql"),
        dadosAte: um("SELECT MAX(criada_em) v FROM matriculas").v,
        registros: um("SELECT COUNT(*) n FROM matriculas").n,
      },
    },
    walletsSemMatch: todos(
      `SELECT COALESCE(NULLIF(TRIM(wallet), ''), '(vazio)') wallet, COUNT(*) n
       FROM matriculas WHERE pessoa_id IS NULL GROUP BY 1 ORDER BY n DESC`),
    vendedoresSemMatch: todos(
      `SELECT vendedor, COUNT(*) n FROM oportunidades
       WHERE pessoa_id IS NULL AND vendedor IS NOT NULL GROUP BY vendedor ORDER BY n DESC`),
    // Matrículas da equipe (consultores) sem oportunidade no CRM, dentro da
    // janela que o Omie cobre — o furo silencioso de atribuição
    matriculasEquipeSemOportunidade: janelaOmie.de
      ? todos(
          `SELECT p.nome pessoa, COUNT(*) n FROM matriculas m
           JOIN pessoas p ON p.id = m.pessoa_id AND p.tipo = 'consultor'
           WHERE m.oportunidade_id IS NULL AND m.criada_em >= ?
             AND (m.status IS NULL OR m.status != 'canceled')
           GROUP BY p.nome ORDER BY n DESC`, janelaOmie.de)
      : [],
    conquistadasSemMatricula: todos(
      `SELECT o.numero, o.conta, COALESCE(p.nome, o.vendedor) vendedor,
              o.ticket_centavos, o.fase_06_em
       FROM oportunidades o LEFT JOIN pessoas p ON p.id = o.pessoa_id
       WHERE o.status = 'Conquistado'
         AND NOT EXISTS (SELECT 1 FROM matriculas m WHERE m.oportunidade_id = o.id)
       ORDER BY o.fase_06_em DESC`),
    conflitosAtribuicao: todos(
      `SELECT m.id matricula_id, m.aluno_nome, m.criada_em, o.numero,
              pw.nome wallet_pessoa, po.nome oportunidade_pessoa
       FROM matriculas m
       JOIN oportunidades o ON o.id = m.oportunidade_id
       JOIN pessoas pw ON pw.id = m.pessoa_id
       JOIN pessoas po ON po.id = o.pessoa_id
       WHERE m.pessoa_id != o.pessoa_id ORDER BY m.criada_em DESC`),
    alunosOrfaos: um(
      `SELECT COUNT(*) n FROM matriculas
       WHERE student_id IS NOT NULL AND aluno_nome IS NULL`).n,
  };
}

// ---------- Dashboard de TV (payload tratado como PÚBLICO) ----------
// Por decisão do usuário (revoga a restrição da Etapa 2), a TV MOSTRA receita
// por consultor e ranking de receita. Continua fora: feedback, pontos de
// melhoria e qualquer texto avaliativo sobre pessoas — só número, e todos
// saem do motor SQL acima. Jornada de referência: 09:00–18:00.

const JORNADA = { inicio: 9, fim: 18 }; // horas locais; define ritmo do dia e atraso útil

const p2 = (n) => String(n).padStart(2, "0");
const isoDia = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function diaUtilAnterior(data) {
  const d = new Date(data + "T00:00:00");
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return isoDia(d);
}

// Fonte atrasada = sem dado desde antes do último dia útil anterior a hoje
// ("mais de 24h úteis"); fim de semana não conta.
function fonteAtrasada(dadosAte, hoje) {
  if (!dadosAte) return true;
  return String(dadosAte).slice(0, 10) < diaUtilAnterior(hoje);
}

// Ritmo do dia parcial: projeção para o fim da jornada com base na HORA DO
// ÚLTIMO DADO (não no relógio — se o upload parou às 10h, o dia "parou" às 10h)
function calcularRitmo(valor, metaDia, horaUltimoDado) {
  if (metaDia == null || !horaUltimoDado) return { projecao: null, estado: null };
  const m = /T(\d{2}):(\d{2})/.exec(horaUltimoDado);
  if (!m) return { projecao: null, estado: null };
  const horas = Number(m[1]) + Number(m[2]) / 60;
  const fracao = Math.min(1, Math.max(0, (horas - JORNADA.inicio) / (JORNADA.fim - JORNADA.inicio)));
  if (fracao < 0.1) return { projecao: null, estado: null, fracao }; // cedo demais para projetar
  const projecao = Math.round(valor / fracao);
  const estado = projecao >= metaDia * 1.1 ? "adiantado" : projecao <= metaDia * 0.9 ? "atrasado" : "no_ritmo";
  return { projecao, estado, fracao };
}

function dadosTvCompleto() {
  const agora = new Date();
  const hoje = isoDia(agora);
  const segunda = new Date(agora);
  segunda.setDate(agora.getDate() - ((agora.getDay() + 6) % 7));
  const semanaDe = isoDia(segunda);
  const mesDe = hoje.slice(0, 8) + "01";
  const mesFim = isoDia(new Date(agora.getFullYear(), agora.getMonth() + 1, 0));

  // ---- Frescor (nunca mostrar dado velho como se fosse de hoje) ----
  const dadoAte = (sql) => db.prepare(sql).get().v;
  const ultimaIngestao = (tipo) =>
    db.prepare(`SELECT concluido_em FROM importacoes
      WHERE tipo = ? AND status = 'concluida' ORDER BY id DESC LIMIT 1`).get(tipo)?.concluido_em ?? null;
  const frescorDe = (dadosAte, tipo) => ({
    dadosAte,
    ultimaIngestao: ultimaIngestao(tipo),
    atrasada: fonteAtrasada(dadosAte, hoje),
  });
  const frescor = {
    cdr: frescorDe(dadoAte("SELECT MAX(data_hora) v FROM ligacoes"), "cdr"),
    omie: frescorDe(dadoAte("SELECT MAX(incluido_em) v FROM oportunidades"), "oportunidades"),
    mysql: frescorDe(dadoAte("SELECT MAX(criada_em) v FROM matriculas"), "mysql"),
  };

  // Quem entra nas visões de prospecção (dia/semana): consultores com
  // entra_painel = 1. A visão do mês (receita) usa todos os consultores.
  const nomesPainel = new Set(
    db.prepare(
      "SELECT nome FROM pessoas WHERE tipo = 'consultor' AND ativo = 1 AND entra_painel = 1"
    ).all().map((p) => p.nome)
  );
  const doPainel = (lista) => lista.filter((p) => nomesPainel.has(p.nome));

  // ---- Dia (parcial, com ritmo) ----
  const mDia = calcularMetricas(hoje, hoje);
  const ultimoDadoHoje = db
    .prepare("SELECT MAX(data_hora) v FROM ligacoes WHERE data_hora >= ?")
    .get(hoje).v;

  // Comparativo: mesmo dia da semana passada ("terça passada: 39"). Uma
  // métrica sem NENHUM dado naquele dia (fonte não cobria) é omitida — zero de
  // verdade (dia coberto, pessoa sem registro) continua aparecendo como 0.
  const dataPassada = new Date(agora);
  dataPassada.setDate(agora.getDate() - 7);
  const diaPassado = isoDia(dataPassada);
  const mPassado = calcularMetricas(diaPassado, diaPassado);
  const passadoPainel = mPassado.porPessoa.filter((p) => nomesPainel.has(p.nome));
  const somaPassado = (fn) => passadoPainel.reduce((s, p) => s + fn(p), 0);
  const comparativo = {
    data: diaPassado,
    temDiscadas: somaPassado((p) => p.ligacoes.discadas.valor) > 0,
    temLeads: somaPassado((p) => p.funil.leadsNovos.valor) > 0,
    temMatriculas: somaPassado((p) => p.matriculas.valor) > 0,
  };
  const passadoPorNome = new Map(passadoPainel.map((p) => [p.nome, {
    discadas: p.ligacoes.discadas.valor,
    leads: p.funil.leadsNovos.valor,
    matriculas: p.matriculas.valor,
  }]));

  const dia = {
    comparativo,
    data: hoje,
    temDadoHoje: !!ultimoDadoHoje,
    dadosAte: ultimoDadoHoje ?? frescor.cdr.dadosAte,
    emCurso: mDia.diasUteis > 0,
    porPessoa: doPainel(mDia.porPessoa).map((p) => {
      const ritmo = calcularRitmo(p.ligacoes.discadas.valor, p.ligacoes.discadas.metaDia, ultimoDadoHoje);
      return {
        nome: p.nome,
        discadas: {
          valor: p.ligacoes.discadas.valor,
          metaDia: p.ligacoes.discadas.metaDia,
          atingimento: p.ligacoes.discadas.atingimento,
          projecao: ritmo.projecao,
          estado: ritmo.estado,
        },
        atendidas: p.ligacoes.atendidas,
        taxaAtendimento: p.ligacoes.taxaAtendimento,
        leads: { valor: p.funil.leadsNovos.valor, metaDia: p.funil.leadsNovos.metaDia },
        matriculas: { valor: p.matriculas.valor, metaDia: p.matriculas.metaDia },
        receitaCentavos: p.receitaCentavos,
        semanaPassada: passadoPorNome.get(p.nome) ?? null,
      };
    }),
    rankingLigacoes: doPainel(mDia.porPessoa)
      .map((p) => ({ nome: p.nome, valor: p.ligacoes.discadas.valor }))
      .sort((a, b) => b.valor - a.valor),
    rankingMatriculas: doPainel(mDia.porPessoa)
      .map((p) => ({ nome: p.nome, valor: p.matriculas.valor }))
      .sort((a, b) => b.valor - a.valor),
  };

  // ---- Semana corrente (meta × dias úteis decorridos — o motor já escala) ----
  const mSemana = calcularMetricas(semanaDe, hoje);
  const semana = {
    de: semanaDe,
    ate: hoje,
    diasUteis: mSemana.diasUteis,
    porPessoa: doPainel(mSemana.porPessoa).map((p) => ({
      nome: p.nome,
      discadas: {
        valor: p.ligacoes.discadas.valor,
        meta: p.ligacoes.discadas.meta,
        atingimento: p.ligacoes.discadas.atingimento,
      },
      atendidas: p.ligacoes.atendidas,
      taxaAtendimento: p.ligacoes.taxaAtendimento,
      leads: { valor: p.funil.leadsNovos.valor, meta: p.funil.leadsNovos.meta, atingimento: p.funil.leadsNovos.atingimento },
      matriculas: { valor: p.matriculas.valor, meta: p.matriculas.meta, atingimento: p.matriculas.atingimento },
      receitaCentavos: p.receitaCentavos,
    })),
    equipe: (() => {
      const lista = doPainel(mSemana.porPessoa);
      const soma = (fn) => lista.reduce((s, p) => s + fn(p), 0);
      return {
        discadas: soma((p) => p.ligacoes.discadas.valor),
        metaDiscadas: soma((p) => p.ligacoes.discadas.meta || 0),
        leadsNovos: soma((p) => p.funil.leadsNovos.valor),
        metaLeads: soma((p) => p.funil.leadsNovos.meta || 0),
        matriculas: soma((p) => p.matriculas.valor),
        metaMatriculas: Math.round(soma((p) => p.matriculas.meta || 0) * 10) / 10,
        vendas: soma((p) => p.funil.vendas),
        receitaCentavos: soma((p) => p.receitaCentavos),
      };
    })(),
    rankingLigacoes: doPainel(mSemana.porPessoa)
      .map((p) => ({ nome: p.nome, valor: p.ligacoes.discadas.valor }))
      .sort((a, b) => b.valor - a.valor),
    rankingLeads: doPainel(mSemana.porPessoa)
      .map((p) => ({ nome: p.nome, valor: p.funil.leadsNovos.valor }))
      .sort((a, b) => b.valor - a.valor),
    rankingReceita: doPainel(mSemana.porPessoa)
      .map((p) => ({ nome: p.nome, valor: p.receitaCentavos }))
      .sort((a, b) => b.valor - a.valor),
  };

  // ---- Mês (receita × meta mensal) ----
  const metasMes = metasVigentes(mesDe, mesFim);
  const receitaMes = new Map(db.prepare(
    `SELECT pessoa_id, SUM(COALESCE(valor_centavos, 0)) receita FROM matriculas
     WHERE criada_em BETWEEN ? AND ? AND (status IS NULL OR status != 'canceled')
       AND pessoa_id IS NOT NULL GROUP BY pessoa_id`).all(mesDe, hoje + "T23:59:59")
    .map((r) => [r.pessoa_id, r.receita]));
  const consultores = db
    .prepare("SELECT id, nome FROM pessoas WHERE tipo = 'consultor' AND ativo = 1 ORDER BY nome")
    .all();
  const decorridos = diasUteis(mesDe, hoje);
  const mes = {
    mes: hoje.slice(0, 7),
    diasUteisDecorridos: decorridos,
    diasUteisRestantes: diasUteis(mesDe, mesFim) - decorridos,
    porPessoa: consultores.map((c) => {
      const meta = metasMes.porPessoa[c.id]?.receita_mes ?? metasMes.padrao.receita_mes ?? null;
      const receita = receitaMes.get(c.id) || 0;
      return {
        nome: c.nome,
        receitaCentavos: receita,
        metaCentavos: meta,
        atingimento: meta ? pct(receita, meta) : null,
        faltaCentavos: meta ? Math.max(0, meta - receita) : null,
      };
    }),
  };

  return { atualizadoEm: new Date().toISOString(), jornada: JORNADA, frescor, dia, semana, mes };
}

module.exports = { diasUteis, metasVigentes, calcularMetricas, saudeDosDados, dadosTvCompleto };
