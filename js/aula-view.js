"use strict";

const aulaId = Number(new URLSearchParams(location.search).get("id"));

function formatarData(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function formatarHora(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatarDuracao(segundos) {
  const s = Math.max(0, Math.round(segundos || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m}min ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

async function carregar() {
  if (!Number.isInteger(aulaId) || aulaId <= 0) {
    location.href = "/aulas";
    return;
  }

  const resposta = await fetch(`/api/aulas/${aulaId}`);
  if (resposta.status === 401) return void (location.href = "/login");
  if (!resposta.ok) return void (location.href = "/aulas");
  const aula = await resposta.json();

  document.title = `${aula.nome} — jonIAs`;
  document.getElementById("nome-aula").textContent = aula.nome;
  document.getElementById("titulo-aula").textContent = aula.nome;
  document.getElementById("meta-aula").innerHTML = [
    `📅 ${formatarData(aula.data_criacao)}`,
    `⏱ ${formatarDuracao(aula.duracao)}`,
    `<span class="chip ${aula.status === "encerrada" ? "chip-encerrada" : "chip-andamento"}">${
      aula.status === "encerrada" ? "encerrada" : "em andamento"
    }</span>`,
  ]
    .map((t) => `<span>${t}</span>`)
    .join("");

  document.getElementById("btn-pdf").href = `/api/aulas/${aulaId}/pdf`;
  document.getElementById("btn-docx").href = `/api/aulas/${aulaId}/docx`;

  // Resumo
  if (aula.resumo_md) {
    document.getElementById("resumo").innerHTML = MarkdownAula.renderizarMarkdown(aula.resumo_md);
  } else {
    document.getElementById("resumo-vazio").classList.remove("oculto");
  }

  // Anotações
  document.getElementById("total-anotacoes").textContent = aula.anotacoes.length;
  const lista = document.getElementById("lista-anotacoes");
  if (aula.anotacoes.length === 0) {
    document.getElementById("anotacoes-vazio").classList.remove("oculto");
  } else {
    lista.innerHTML = aula.anotacoes
      .map(
        (a) => `
        <div class="anotacao-cronologica">
          <span class="anotacao-hora">${formatarHora(a.timestamp)}</span>
          <span>${escapeHtml(a.texto)}</span>
        </div>`
      )
      .join("");
  }

  // Transcrição
  const transcricao = document.getElementById("transcricao-completa");
  transcricao.textContent = aula.transcricao_completa || "(transcrição vazia)";
}

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregar();
