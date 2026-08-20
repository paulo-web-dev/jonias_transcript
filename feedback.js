"use strict";

// Etapa 3 — camada de IA sobre as métricas: feedback individual por período.
// A IA NUNCA produz números: recebe um "dossiê de fatos" já calculado e
// FORMATADO pelo motor SQL (metricas.js → snapshot congelado) e escreve apenas
// o texto qualitativo em volta deles. O dossiê enviado fica gravado em
// feedbacks.fatos_json — todo texto é auditável contra os fatos que o geraram.
//
// Minimização de dados: o dossiê leva só os números do próprio consultor,
// agregados da equipe e posições de ranking prontas ("2º de 6") — nomes de
// colegas nunca chegam ao modelo, então o texto não tem como compará-los.

const formatoReais = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const reais = (centavos) => formatoReais.format((centavos || 0) / 100);
const num = (v, casas = 1) =>
  v == null ? null : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const pctTexto = (p) => (p == null ? null : `${num(p)}%`);
const segundos = (s) =>
  s == null
    ? null
    : s >= 60
      ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
      : `${s}s`;
const dataBr = (iso) => String(iso).slice(0, 10).split("-").reverse().join("/");

// Posição no ranking da equipe (1º = maior valor; empate divide a posição)
function posicao(todos, pessoaId, valorDe) {
  const meu = valorDe(todos.find((c) => c.pessoaId === pessoaId));
  const acima = todos.filter((c) => valorDe(c) > meu).length;
  return `${acima + 1}º de ${todos.length}`;
}

// Até a comparação "acima/abaixo da média" vem pronta — deixar o modelo
// comparar decimais já produziu conclusão invertida em teste.
function comparar(valor, referencia) {
  if (valor == null || referencia == null) return null;
  if (valor > referencia) return "acima da média da equipe";
  if (valor < referencia) return "abaixo da média da equipe";
  return "igual à média da equipe";
}

// Monta o dossiê de fatos de UM consultor a partir do snapshot congelado
// (dados = saída de calcularMetricas). Retorna null se o consultor não está no
// snapshot (ex.: snapshot anterior ao cadastro da pessoa).
function prepararFatosFeedback(periodo, dados, pessoaId) {
  const todos = dados.porPessoa || [];
  const p = todos.find((c) => c.pessoaId === pessoaId);
  if (!p) return null;
  const n = todos.length;
  const eq = dados.equipe;
  const media = (total) => (n ? num(total / n) : null);

  const observacoes = [];
  if (p.conflitosAtribuicao) {
    observacoes.push(
      `${p.conflitosAtribuicao} matrícula(s) com atribuição em conflito ` +
        "(wallet ≠ vendedor no CRM) — valeu o wallet, como definido pela operação."
    );
  }
  if (p.funil.perdidasAproximadas) {
    observacoes.push(
      `${p.funil.perdidasAproximadas} das oportunidades perdidas usam data aproximada ` +
        "(o CRM não registrou a data real da perda)."
    );
  }

  return {
    periodo: {
      nome: periodo.nome,
      inicio: dataBr(dados.de),
      fim: dataBr(dados.ate),
      diasUteis: dados.diasUteis,
    },
    consultor: p.nome,
    equipe: { consultores: n },
    ligacoes: {
      discadas: p.ligacoes.discadas.valor,
      metaDoPeriodo: p.ligacoes.discadas.meta,
      atingimentoDaMeta: pctTexto(p.ligacoes.discadas.atingimento),
      posicaoNaEquipe: posicao(todos, pessoaId, (c) => c.ligacoes.discadas.valor),
      mediaPorConsultor: media(eq.discadas),
      comparacaoComAMedia: comparar(p.ligacoes.discadas.valor, n ? eq.discadas / n : null),
      atendidas: p.ligacoes.atendidas,
      taxaAtendimento: pctTexto(p.ligacoes.taxaAtendimento),
      taxaAtendimentoDaEquipe: pctTexto(eq.taxaAtendimento),
      taxaAtendimentoComparacao: comparar(p.ligacoes.taxaAtendimento, eq.taxaAtendimento),
      tempoMedioDeConversa: segundos(p.ligacoes.tmaSeg),
      tempoMedioDeConversaDaEquipe: segundos(eq.tmaSeg),
    },
    funil: {
      leadsNovos: p.funil.leadsNovos.valor,
      metaDoPeriodo: p.funil.leadsNovos.meta,
      atingimentoDaMeta: pctTexto(p.funil.leadsNovos.atingimento),
      posicaoNaEquipe: posicao(todos, pessoaId, (c) => c.funil.leadsNovos.valor),
      mediaPorConsultor: media(eq.leadsNovos),
      comparacaoComAMedia: comparar(p.funil.leadsNovos.valor, n ? eq.leadsNovos / n : null),
      leadsPorFaseAtual: p.funil.porFase,
      oportunidadesPerdidas: p.funil.perdidas,
      vendasFechadas: p.funil.vendas,
      valorVendido: reais(p.funil.ticketCentavos),
    },
    matriculas: {
      matriculas: p.matriculas.valor,
      metaDoPeriodo: p.matriculas.meta,
      atingimentoDaMeta: pctTexto(p.matriculas.atingimento),
      posicaoNaEquipe: posicao(todos, pessoaId, (c) => c.matriculas.valor),
      receita: reais(p.receitaCentavos),
      receitaMediaPorConsultor: reais(n ? eq.receitaCentavos / n : 0),
      receitaComparacao: comparar(p.receitaCentavos, n ? eq.receitaCentavos / n : null),
    },
    observacoes,
  };
}

const SYSTEM_FEEDBACK =
  "Você é o jonIAs, assistente de dados da operação comercial. Escreva o feedback " +
  "individual de desempenho de um consultor comercial para o período informado, com base " +
  "EXCLUSIVAMENTE no dossiê de fatos em JSON — todos os números já foram calculados pelo " +
  "motor de métricas.\n\n" +
  "REGRAS INEGOCIÁVEIS:\n" +
  "- NUNCA invente, recalcule, some, projete, converta ou arredonde números. Ao citar um " +
  "número, copie-o EXATAMENTE como está no dossiê, com a mesma formatação.\n" +
  "- Campo nulo ou ausente: não mencione e não especule.\n" +
  "- Não cite colegas pelo nome (o dossiê não os traz): compare apenas com a média da " +
  "equipe e com a posição no ranking, que já vêm prontas.\n" +
  "- NUNCA conclua sozinho se um valor está acima ou abaixo da média: use apenas os " +
  "campos de comparação prontos ('comparacaoComAMedia', 'posicaoNaEquipe' etc.).\n" +
  "- Tom respeitoso, direto e construtivo — fale de fatos e comportamentos, nunca de " +
  "caráter. Elogie apenas o que os números sustentam; lacunas viram oportunidade com " +
  "sugestão prática.\n" +
  "- Português do Brasil. Responda APENAS o Markdown, sem comentários fora dele.\n\n" +
  "FORMATO:\n" +
  "# Feedback — <consultor> (<início> a <fim>)\n" +
  "## Resumo do período — 2 a 3 frases\n" +
  "## Destaques — bullets do que foi bem, com os números\n" +
  "## Pontos de atenção — bullets do que ficou abaixo, sempre com o número citado\n" +
  "## Sugestões para o próximo período — 2 a 4 ações práticas ligadas aos pontos de atenção\n\n" +
  "CONTEXTO DO NEGÓCIO: 'discadas' medem esforço de prospecção; 'atendidas' e taxa de " +
  "atendimento medem qualidade da lista; o tempo médio de conversa não inclui o tempo de " +
  "toque; leads novos são oportunidades criadas no CRM; matrículas, vendas e receita são " +
  "três medidas distintas (uma venda pode virar várias matrículas). Perdidas com data " +
  "aproximada usam a data de atualização do CRM, não a da perda real.";

async function gerarFeedbackMarkdown(anthropic, modelo, fatos) {
  const response = await anthropic.messages.create({
    model: modelo,
    max_tokens: 1500,
    system: SYSTEM_FEEDBACK,
    messages: [
      {
        role: "user",
        content: "Dossiê de fatos do período:\n\n" + JSON.stringify(fatos, null, 2),
      },
    ],
  });
  return response.content.find((b) => b.type === "text")?.text ?? "";
}

module.exports = { prepararFatosFeedback, gerarFeedbackMarkdown };
