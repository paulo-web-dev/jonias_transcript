"use strict";

// Palavras por bloco de anotações. Padrão 400; pode ser reduzido para teste
// via URL: /aula-ao-vivo?id=N&bloco=30
const PALAVRAS_POR_BLOCO = (() => {
  const p = Number(new URLSearchParams(location.search).get("bloco"));
  return Number.isFinite(p) && p > 0 ? p : 400;
})();

// Aula desta sessão (obrigatória — sem id volta para a lista)
const aulaId = Number(new URLSearchParams(location.search).get("id"));

// ---------- Elementos ----------
const el = {
  robo: document.getElementById("robo"),
  roboStatus: document.getElementById("robo-status"),
  btnIniciar: document.getElementById("btn-iniciar"),
  btnPausar: document.getElementById("btn-pausar"),
  btnEncerrar: document.getElementById("btn-encerrar"),
  tempoAula: document.getElementById("tempo-aula"),
  totalPalavras: document.getElementById("total-palavras"),
  totalBlocos: document.getElementById("total-blocos"),
  progressoTexto: document.getElementById("progresso-texto"),
  progressoPreenchido: document.getElementById("progresso-preenchido"),
  anotacoesLista: document.getElementById("anotacoes-lista"),
  anotacoesVazio: document.getElementById("anotacoes-vazio"),
  transcricaoScroll: document.getElementById("transcricao-scroll"),
  transcricaoFinal: document.getElementById("transcricao-final"),
  transcricaoInterina: document.getElementById("transcricao-interina"),
  transcricaoVazio: document.getElementById("transcricao-vazio"),
  bannerErro: document.getElementById("banner-erro"),
  aviso: document.getElementById("aviso"),
  modalResumo: document.getElementById("modal-resumo"),
  resumoConteudo: document.getElementById("resumo-conteudo"),
  btnBaixarResumo: document.getElementById("btn-baixar-resumo"),
  btnFecharResumo: document.getElementById("btn-fechar-resumo"),
  nomeAula: document.getElementById("nome-aula"),
  btnSair: document.getElementById("btn-sair"),
  btnVerAula: document.getElementById("btn-ver-aula"),
  btnBaixarPdf: document.getElementById("btn-baixar-pdf"),
  btnBaixarDocx: document.getElementById("btn-baixar-docx"),
};

// ---------- Estado da sessão ----------
const sessao = {
  ativa: false,
  pausada: false,
  processando: false,
  inicioMs: 0,
  msAcumulados: 0, // tempo antes da última pausa
  totalPalavras: 0,
  textoPendente: "", // texto ainda não enviado para anotações
  transcricaoCompleta: "",
  numeroBloco: 0,
  timerId: null,
  despachoAtual: null, // promise do bloco em voo — o encerramento espera por ela
};

// Todos os tópicos já gerados — enviados à API para evitar repetição
const anotacoesGeradas = [];

let resumoMarkdown = "";
let recognition = null;
let avisoTimerId = null;

// ---------- Robô ----------
function setRobo(estado, mensagem) {
  el.robo.dataset.estado = estado;
  if (mensagem !== undefined) el.roboStatus.textContent = mensagem;
}

// ---------- Web Speech API ----------
function criarReconhecimento() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    mostrarErro(
      "Seu navegador não suporta a Web Speech API. Use o Google Chrome."
    );
    el.btnIniciar.disabled = true;
    return null;
  }
  const rec = new SR();
  rec.lang = "pt-BR";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (evento) => {
    let interina = "";
    for (let i = evento.resultIndex; i < evento.results.length; i++) {
      const resultado = evento.results[i];
      const texto = resultado[0].transcript.trim();
      if (!texto) continue;
      if (resultado.isFinal) {
        adicionarTextoFinal(texto);
      } else {
        interina += texto + " ";
      }
    }
    el.transcricaoInterina.textContent = interina;
    rolarTranscricao();
  };

  rec.onerror = (evento) => {
    // "no-speech" e "aborted" são esperados no modo contínuo; onend reinicia.
    if (evento.error === "not-allowed" || evento.error === "service-not-allowed") {
      mostrarErro(
        "Acesso ao microfone negado. Permita o microfone nas configurações do site e recarregue a página."
      );
      encerrarAula();
    }
  };

  // Reinício automático: o Chrome encerra o reconhecimento sozinho de tempos
  // em tempos, mesmo em modo contínuo.
  rec.onend = () => {
    if (sessao.ativa && !sessao.pausada) {
      setTimeout(() => {
        if (sessao.ativa && !sessao.pausada) {
          try {
            rec.start();
          } catch (_) {
            /* já estava rodando */
          }
        }
      }, 250);
    }
  };

  return rec;
}

// ---------- Transcrição ----------
function contarPalavras(texto) {
  return texto.split(/\s+/).filter(Boolean).length;
}

function adicionarTextoFinal(texto) {
  el.transcricaoVazio.classList.add("oculto");

  // Remove destaque do trecho anterior e adiciona o novo destacado
  el.transcricaoFinal
    .querySelectorAll("span.recente")
    .forEach((s) => s.classList.remove("recente"));
  const span = document.createElement("span");
  span.className = "recente";
  span.textContent = texto + " ";
  el.transcricaoFinal.appendChild(span);

  sessao.totalPalavras += contarPalavras(texto);
  sessao.textoPendente += (sessao.textoPendente ? " " : "") + texto;
  sessao.transcricaoCompleta += (sessao.transcricaoCompleta ? " " : "") + texto;

  atualizarContadores();

  const pendentes = contarPalavras(sessao.textoPendente);
  if (pendentes >= PALAVRAS_POR_BLOCO && !sessao.processando) {
    sessao.despachoAtual = despacharBloco();
  }
}

function rolarTranscricao() {
  el.transcricaoScroll.scrollTop = el.transcricaoScroll.scrollHeight;
}

function atualizarContadores() {
  el.totalPalavras.textContent = sessao.totalPalavras;
  el.totalBlocos.textContent = sessao.numeroBloco;
  const pendentes = contarPalavras(sessao.textoPendente);
  el.progressoTexto.textContent = `${Math.min(pendentes, PALAVRAS_POR_BLOCO)} / ${PALAVRAS_POR_BLOCO}`;
  el.progressoPreenchido.style.width =
    Math.min(100, (pendentes / PALAVRAS_POR_BLOCO) * 100) + "%";
}

// ---------- Geração de anotações (API do Claude via backend) ----------
async function despacharBloco(ehFinal = false) {
  if (sessao.processando) return; // nunca dois blocos em voo ao mesmo tempo
  const texto = sessao.textoPendente.trim();
  if (!texto) return;

  sessao.textoPendente = "";
  sessao.processando = true;
  atualizarContadores();
  setRobo("processing", "jonIAs está anotando…");

  let sucesso = false;
  try {
    const numero = sessao.numeroBloco + 1;
    const anotacoes = await gerarAnotacoes(texto, numero, ehFinal);
    sessao.numeroBloco = numero;
    sucesso = true;
    if (anotacoes.topicos.length > 0) criarCard(anotacoes, ehFinal);
    atualizarContadores();
  } catch (erro) {
    if (erro.aulaEncerrada) {
      // A aula já foi encerrada no servidor (409): a transcrição completa já
      // está salva — descarta o bloco sem reenfileirar nem avisar em loop.
    } else {
      // Devolve o bloco para a fila: será reenviado junto com o próximo
      sessao.textoPendente =
        texto + (sessao.textoPendente ? " " + sessao.textoPendente : "");
      atualizarContadores();
      mostrarAviso(`Falha ao gerar anotações — o bloco será reenviado. (${erro.message})`);
    }
  } finally {
    sessao.processando = false;
    if (sessao.ativa) {
      if (!sessao.pausada) setRobo("listening", "jonIAs está ouvindo…");
      else setRobo("paused", "jonIAs pausado");
    }
    // Se acumulou outro bloco completo enquanto este era processado, despacha já.
    // Após uma falha, espera a próxima fala para tentar de novo (evita loop de erros).
    if (
      sucesso &&
      sessao.ativa &&
      contarPalavras(sessao.textoPendente) >= PALAVRAS_POR_BLOCO
    ) {
      sessao.despachoAtual = despacharBloco();
    }
  }
}

/**
 * Chama o backend (/api/anotacoes), que fala com a API do Claude.
 * Retorna { titulo, topicos }.
 */
async function gerarAnotacoes(textoDoBloco, numeroBloco, ehFinal) {
  const resposta = await fetch("/api/anotacoes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      textoNovo: textoDoBloco,
      anotacoesAnteriores: anotacoesGeradas,
      aulaId,
      // transcrição parcial salva junto: se o navegador cair, nada se perde
      transcricaoParcial: sessao.transcricaoCompleta,
    }),
  });

  if (resposta.status === 401) {
    location.href = "/login";
    throw new Error("sessão expirada");
  }

  if (resposta.status === 409) {
    // Aula encerrada no servidor enquanto o bloco estava em voo
    const erro = new Error("aula já encerrada");
    erro.aulaEncerrada = true;
    throw erro;
  }

  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    throw new Error(corpo.error || `erro ${resposta.status}`);
  }

  const dados = await resposta.json();
  const topicos = Array.isArray(dados.topicos) ? dados.topicos : [];
  anotacoesGeradas.push(...topicos);

  return {
    titulo: ehFinal ? "Bloco final" : `Bloco ${numeroBloco}`,
    topicos,
  };
}

function criarCard(anotacoes, ehFinal) {
  el.anotacoesVazio.classList.add("oculto");

  const card = document.createElement("div");
  card.className = "card-anotacao" + (ehFinal ? " card-resumo" : "");

  const hora = new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  card.innerHTML = `
    <div class="card-cabecalho">
      <span class="card-titulo">${escapeHtml(anotacoes.titulo)}</span>
      <span class="card-hora">${hora}</span>
    </div>
    <ul>${anotacoes.topicos.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
  `;

  el.anotacoesLista.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

// ---------- Encerramento: salva a aula e gera o resumo ----------
async function encerrarNoServidor(duracaoSegundos) {
  setRobo("processing", "jonIAs está salvando e resumindo a aula…");
  try {
    const resposta = await fetch(`/api/aulas/${aulaId}/encerrar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcricao: sessao.transcricaoCompleta,
        duracao: duracaoSegundos,
      }),
    });

    if (resposta.status === 401) return void (location.href = "/login");
    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => ({}));
      throw new Error(corpo.error || `erro ${resposta.status}`);
    }

    const dados = await resposta.json();
    resumoMarkdown = dados.resumo || "";
    if (dados.erroResumo) mostrarAviso(dados.erroResumo);
    if (resumoMarkdown) {
      el.resumoConteudo.innerHTML = MarkdownAula.renderizarMarkdown(resumoMarkdown);
      el.modalResumo.classList.remove("oculto");
    }
  } catch (erro) {
    mostrarAviso(`Não foi possível salvar/resumir a aula. (${erro.message})`);
  }
}

function baixarResumo() {
  if (!resumoMarkdown) return;
  const data = new Date().toISOString().slice(0, 10);
  const blob = new Blob([resumoMarkdown], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `resumo-aula-${data}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- Timer ----------
function iniciarTimer() {
  sessao.inicioMs = Date.now();
  sessao.timerId = setInterval(() => {
    const totalMs = sessao.msAcumulados + (Date.now() - sessao.inicioMs);
    const seg = Math.floor(totalMs / 1000);
    const mm = String(Math.floor(seg / 60)).padStart(2, "0");
    const ss = String(seg % 60).padStart(2, "0");
    el.tempoAula.textContent = `${mm}:${ss}`;
  }, 500);
}

function pararTimer() {
  clearInterval(sessao.timerId);
  sessao.timerId = null;
}

// ---------- Controles ----------
function iniciarAula() {
  if (!recognition) recognition = criarReconhecimento();
  if (!recognition) return;

  esconderErro();
  sessao.ativa = true;
  sessao.pausada = false;

  try {
    recognition.start();
  } catch (_) {
    /* já estava rodando */
  }

  iniciarTimer();
  setRobo("listening", "jonIAs está ouvindo…");

  el.btnIniciar.disabled = true;
  el.btnPausar.disabled = false;
  el.btnEncerrar.disabled = false;
}

function alternarPausa() {
  if (!sessao.ativa) return;

  if (!sessao.pausada) {
    sessao.pausada = true;
    recognition.stop();
    sessao.msAcumulados += Date.now() - sessao.inicioMs;
    pararTimer();
    setRobo("paused", "jonIAs pausado");
    el.btnPausar.innerHTML = '<span class="btn-icone">▶</span> Retomar';
  } else {
    sessao.pausada = false;
    try {
      recognition.start();
    } catch (_) {}
    iniciarTimer();
    if (!sessao.processando) setRobo("listening", "jonIAs está ouvindo…");
    el.btnPausar.innerHTML = '<span class="btn-icone">⏸</span> Pausar';
  }
}

async function encerrarAula() {
  if (!sessao.ativa) return;

  sessao.ativa = false;
  sessao.pausada = false;
  recognition.stop();
  el.transcricaoInterina.textContent = "";

  if (sessao.timerId) {
    sessao.msAcumulados += Date.now() - sessao.inicioMs;
    pararTimer();
  }

  el.btnIniciar.disabled = true; // aula encerrada não recomeça nesta tela
  el.btnPausar.disabled = true;
  el.btnEncerrar.disabled = true;
  el.btnPausar.innerHTML = '<span class="btn-icone">⏸</span> Pausar';

  // Espera o bloco em voo terminar (com ativa=false ele não encadeia outro):
  // encerrar antes dele faria a resposta atrasada gravar por cima do final.
  while (sessao.despachoAtual) {
    const emVoo = sessao.despachoAtual;
    await emVoo;
    if (sessao.despachoAtual === emVoo) sessao.despachoAtual = null;
  }

  // Gera um último card com o que sobrou da transcrição
  if (sessao.textoPendente.trim()) {
    await despacharBloco(true);
  }

  // Salva transcrição/duração no banco e gera o resumo estruturado
  await encerrarNoServidor(Math.round(sessao.msAcumulados / 1000));

  setRobo(
    "idle",
    `Aula encerrada — ${sessao.totalPalavras} palavras em ${sessao.numeroBloco} bloco(s)`
  );
}

// ---------- Erros e avisos ----------
function mostrarErro(mensagem) {
  el.bannerErro.textContent = mensagem;
  el.bannerErro.classList.remove("oculto");
}

function esconderErro() {
  el.bannerErro.classList.add("oculto");
}

// Aviso discreto (toast) que some sozinho — não trava a sessão
function mostrarAviso(mensagem) {
  el.aviso.textContent = "⚠ " + mensagem;
  el.aviso.classList.add("visivel");
  clearTimeout(avisoTimerId);
  avisoTimerId = setTimeout(() => el.aviso.classList.remove("visivel"), 8000);
}

// ---------- Inicialização ----------
el.btnIniciar.addEventListener("click", iniciarAula);
el.btnPausar.addEventListener("click", alternarPausa);
el.btnEncerrar.addEventListener("click", encerrarAula);
el.btnBaixarResumo.addEventListener("click", baixarResumo);
el.btnFecharResumo.addEventListener("click", () =>
  el.modalResumo.classList.add("oculto")
);
el.modalResumo.addEventListener("click", (evento) => {
  if (evento.target === el.modalResumo) el.modalResumo.classList.add("oculto");
});
el.btnSair.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

// Carrega a aula desta sessão; sem aula válida, volta para a lista
async function carregarAula() {
  el.btnIniciar.disabled = true;
  if (!Number.isInteger(aulaId) || aulaId <= 0) return void (location.href = "/aulas");

  const resposta = await fetch(`/api/aulas/${aulaId}`).catch(() => null);
  if (!resposta || resposta.status === 401) return void (location.href = "/login");
  if (!resposta.ok) return void (location.href = "/aulas");

  const aula = await resposta.json();
  if (aula.status === "encerrada") return void (location.href = `/aula?id=${aulaId}`);

  document.title = `${aula.nome} — jonIAs`;
  el.nomeAula.textContent = aula.nome;
  el.btnVerAula.href = "/aulas";
  el.btnBaixarPdf.href = `/api/aulas/${aulaId}/pdf`;
  el.btnBaixarDocx.href = `/api/aulas/${aulaId}/docx`;
  el.btnIniciar.disabled = false;
}

atualizarContadores();

if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
  mostrarErro("Seu navegador não suporta a Web Speech API. Use o Google Chrome.");
} else {
  carregarAula();
}
