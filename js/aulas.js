"use strict";

const el = {
  busca: document.getElementById("campo-busca"),
  lista: document.getElementById("lista-aulas"),
  vazia: document.getElementById("lista-vazia"),
  btnNova: document.getElementById("btn-nova-aula"),
  btnSair: document.getElementById("btn-sair"),
  modalNome: document.getElementById("modal-nome"),
  modalNomeTitulo: document.getElementById("modal-nome-titulo"),
  campoNome: document.getElementById("campo-nome-aula"),
  modalNomeErro: document.getElementById("modal-nome-erro"),
  btnConfirmarNome: document.getElementById("btn-confirmar-nome"),
  modalExcluir: document.getElementById("modal-excluir"),
  textoExcluir: document.getElementById("texto-excluir"),
  btnConfirmarExcluir: document.getElementById("btn-confirmar-excluir"),
  btnCancelarExcluir: document.getElementById("btn-cancelar-excluir"),
};

// null = criando aula nova; número = renomeando a aula desse id
let idEmEdicao = null;
let idParaExcluir = null;
let buscaTimerId = null;

// ---------- Utilitários ----------

async function chamarApi(url, opcoes) {
  const resposta = await fetch(url, opcoes);
  if (resposta.status === 401) {
    location.href = "/login";
    throw new Error("sessão expirada");
  }
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(corpo.error || `erro ${resposta.status}`);
  return corpo;
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

function formatarData(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
        " " +
        d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatarDuracao(segundos) {
  const s = Math.max(0, Math.round(segundos || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

function abrirModal(modal) {
  modal.classList.remove("oculto");
}
function fecharModal(modal) {
  modal.classList.add("oculto");
}

// ---------- Lista ----------

async function carregarAulas() {
  const busca = el.busca.value.trim();
  const dados = await chamarApi(`/api/aulas?busca=${encodeURIComponent(busca)}`);
  renderizarLista(dados.aulas);
}

function renderizarLista(aulas) {
  el.lista.innerHTML = "";
  el.vazia.classList.toggle("oculto", aulas.length > 0);

  for (const aula of aulas) {
    const encerrada = aula.status === "encerrada";
    const item = document.createElement("div");
    item.className = "aula-item";
    item.innerHTML = `
      <div class="aula-info">
        <div class="aula-nome-linha">
          <span class="aula-nome">${escapeHtml(aula.nome)}</span>
          <span class="chip ${encerrada ? "chip-encerrada" : "chip-andamento"}">
            ${encerrada ? "encerrada" : "em andamento"}
          </span>
        </div>
        <div class="aula-meta">
          <span>📅 ${formatarData(aula.data_criacao)}</span>
          <span>⏱ ${formatarDuracao(aula.duracao)}</span>
          <span>📝 ${aula.total_anotacoes} anotação(ões)</span>
        </div>
      </div>
      <div class="aula-acoes">
        <button class="btn btn-secundario btn-mini" data-acao="abrir">
          ${encerrada ? "Abrir" : "Continuar"}
        </button>
        <button class="btn btn-secundario btn-mini" data-acao="renomear">Renomear</button>
        <button class="btn btn-perigo btn-mini" data-acao="excluir">Excluir</button>
      </div>
    `;

    item.querySelector('[data-acao="abrir"]').addEventListener("click", () => {
      location.href = encerrada ? `/aula?id=${aula.id}` : `/aula-ao-vivo?id=${aula.id}`;
    });
    item.querySelector('[data-acao="renomear"]').addEventListener("click", () => {
      idEmEdicao = aula.id;
      el.modalNomeTitulo.textContent = "Renomear aula";
      el.campoNome.value = aula.nome;
      el.modalNomeErro.classList.add("oculto");
      abrirModal(el.modalNome);
      el.campoNome.focus();
    });
    item.querySelector('[data-acao="excluir"]').addEventListener("click", () => {
      idParaExcluir = aula.id;
      el.textoExcluir.innerHTML = `Excluir a aula <strong>${escapeHtml(aula.nome)}</strong>?`;
      abrirModal(el.modalExcluir);
    });

    el.lista.appendChild(item);
  }
}

// ---------- Criar / renomear ----------

el.btnNova.addEventListener("click", () => {
  idEmEdicao = null;
  el.modalNomeTitulo.textContent = "Nova Aula";
  el.campoNome.value = "";
  el.modalNomeErro.classList.add("oculto");
  abrirModal(el.modalNome);
  el.campoNome.focus();
});

async function confirmarNome() {
  const nome = el.campoNome.value.trim();
  if (!nome) {
    el.modalNomeErro.textContent = "Informe o nome da aula.";
    el.modalNomeErro.classList.remove("oculto");
    return;
  }
  try {
    if (idEmEdicao === null) {
      const criada = await chamarApi("/api/aulas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome }),
      });
      location.href = `/aula-ao-vivo?id=${criada.id}`;
    } else {
      await chamarApi(`/api/aulas/${idEmEdicao}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome }),
      });
      fecharModal(el.modalNome);
      carregarAulas();
    }
  } catch (erro) {
    el.modalNomeErro.textContent = erro.message;
    el.modalNomeErro.classList.remove("oculto");
  }
}

el.btnConfirmarNome.addEventListener("click", confirmarNome);
el.campoNome.addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmarNome();
});

// ---------- Excluir ----------

el.btnConfirmarExcluir.addEventListener("click", async () => {
  if (idParaExcluir === null) return;
  try {
    await chamarApi(`/api/aulas/${idParaExcluir}`, { method: "DELETE" });
  } finally {
    idParaExcluir = null;
    fecharModal(el.modalExcluir);
    carregarAulas();
  }
});
el.btnCancelarExcluir.addEventListener("click", () => fecharModal(el.modalExcluir));

// ---------- Busca, modais e sessão ----------

el.busca.addEventListener("input", () => {
  clearTimeout(buscaTimerId);
  buscaTimerId = setTimeout(carregarAulas, 250);
});

document.querySelectorAll("[data-fechar]").forEach((botao) => {
  botao.addEventListener("click", () =>
    fecharModal(document.getElementById(botao.dataset.fechar))
  );
});
[el.modalNome, el.modalExcluir].forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) fecharModal(modal);
  });
});

el.btnSair.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregarAulas();
