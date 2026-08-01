"use strict";

const form = document.getElementById("form-login");
const erro = document.getElementById("login-erro");

form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  erro.classList.add("oculto");

  const botao = form.querySelector("button");
  botao.disabled = true;

  try {
    const resposta = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usuario: document.getElementById("usuario").value.trim(),
        senha: document.getElementById("senha").value,
      }),
    });

    if (resposta.ok) {
      location.href = "/aulas";
      return;
    }
    const corpo = await resposta.json().catch(() => ({}));
    erro.textContent = corpo.error || "Falha ao entrar.";
    erro.classList.remove("oculto");
  } catch (_) {
    erro.textContent = "Não foi possível conectar ao servidor.";
    erro.classList.remove("oculto");
  } finally {
    botao.disabled = false;
  }
});
