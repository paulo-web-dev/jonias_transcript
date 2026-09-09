"use strict";

const form = document.getElementById("form-senha");
const erro = document.getElementById("senha-erro");

fetch("/api/sessao").then((r) => (r.ok ? r.json() : null)).then((s) => {
  if (!s) return;
  document.getElementById("subtitulo").textContent = s.trocarSenha
    ? `Olá, ${s.nome}. Troque a senha inicial para continuar.`
    : `${s.nome} — trocar senha`;
  if (!s.trocarSenha) document.querySelector("#senha-atual").previousElementSibling.textContent = "Senha atual";
}).catch(() => {});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  erro.classList.add("oculto");
  const nova = document.getElementById("senha-nova").value;
  if (nova !== document.getElementById("senha-confirma").value) {
    erro.textContent = "A confirmação não confere com a senha nova.";
    erro.classList.remove("oculto");
    return;
  }
  const botao = form.querySelector("button");
  botao.disabled = true;
  try {
    const r = await fetch("/api/senha", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senhaAtual: document.getElementById("senha-atual").value, senhaNova: nova }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (r.ok) { location.href = corpo.destino || "/"; return; }
    erro.textContent = corpo.error || "Não foi possível trocar a senha.";
    erro.classList.remove("oculto");
  } catch (_) {
    erro.textContent = "Não foi possível conectar ao servidor.";
    erro.classList.remove("oculto");
  } finally {
    botao.disabled = false;
  }
});

document.getElementById("link-sair").addEventListener("click", async (ev) => {
  ev.preventDefault();
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});
