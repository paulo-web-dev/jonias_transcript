"use strict";

// Gera os arquivos de referência territorial a partir das APIs públicas do
// IBGE. Roda UMA vez, com internet, e o resultado é versionado em dados/ —
// o servidor nunca acessa o IBGE em runtime (o container pode não ter rede).
//
//   node scripts/gerar-referencias-territorio.js
//
// Saídas:
//   dados/municipios_ibge_PR_SC.json  [{codigo, uf, nome}]      — 694 municípios
//   dados/municipios_brasil.json      [{nome, uf}]              — todos os 5.5xx do país
//                                     (só para classificar "cidade de outro estado")
//   dados/mapa_PR_SC.svg              malha municipal de PR + SC fundida num único SVG
//                                     (qualidade mínima do IBGE; path id = "m<código>")

//   dados/vizinhos_PR_SC.json         { "<código>": [códigos vizinhos] } — derivado da própria
//                                     malha (municípios que compartilham ≥ 2 vértices; ≥ 1 quando
//                                     o município ficaria isolado). Sem rede: `--so-vizinhos`
//                                     recalcula só este arquivo a partir do SVG já salvo.

const fs = require("fs");
const path = require("path");

const IBGE_LOCALIDADES = "https://servicodados.ibge.gov.br/api/v1/localidades";
const IBGE_MALHAS = "https://servicodados.ibge.gov.br/api/v3/malhas/estados";
const UFS = { 41: "PR", 42: "SC" };
const DADOS = path.join(__dirname, "..", "dados");

async function baixar(url, comoTexto) {
  const r = await fetch(url, { headers: { Accept: comoTexto ? "image/svg+xml" : "application/json" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return comoTexto ? r.text() : r.json();
}

function ufDoMunicipio(m) {
  return (
    m.microrregiao?.mesorregiao?.UF?.sigla ||
    m["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla ||
    null
  );
}

// A malha do IBGE vem como <svg viewBox="lon lat w h"><g transform="scale(0.0001,-0.0001)">
// <path id="4100103" d="..."/>…  As duas UFs usam o mesmo sistema de coordenadas,
// então basta unir os viewBox e concatenar os <g>.
function extrairMalha(svg, codigoUf) {
  const vb = svg.match(/viewBox="([^"]+)"/);
  const g = svg.match(/<g id="[^"]*"[^>]*transform="([^"]+)"[^>]*>([\s\S]*?)<\/g>/);
  if (!vb || !g) throw new Error(`malha da UF ${codigoUf}: formato inesperado`);
  const [x, y, w, h] = vb[1].split(/\s+/).map(Number);
  const paths = g[2].replace(/<path id="(\d+)"/g, '<path id="m$1"');
  const qtde = (paths.match(/<path /g) || []).length;
  return { x, y, w, h, transform: g[1], paths, qtde };
}

// Vizinhança pela geometria: dois municípios são vizinhos quando seus contornos
// compartilham ≥ 2 vértices idênticos (a malha do IBGE é topológica: a
// fronteira comum tem os mesmos pontos dos dois lados). Município que ficaria
// sem vizinho (ex.: Sengés, na divisa com SP) aceita 1 vértice em comum.
function gerarVizinhos(svg) {
  const paths = [...svg.matchAll(/<path id="m(\d+)" d="([^"]+)"/g)];
  const porVertice = new Map();
  for (const [, codigo, d] of paths) {
    const tokens = d.match(/[MmLlZz]|-?\d+(?:\.\d+)?/g) || [];
    let x = 0, y = 0, cmd = null;
    for (let i = 0; i < tokens.length;) {
      const t = tokens[i];
      if (/[MmLlZz]/.test(t)) { cmd = t; i++; continue; }
      const a = Number(tokens[i]), b = Number(tokens[i + 1]);
      i += 2;
      if (cmd === "M" || cmd === "L") { x = a; y = b; } else { x += a; y += b; }
      const k = `${x},${y}`;
      (porVertice.get(k) ?? porVertice.set(k, new Set()).get(k)).add(codigo);
    }
  }
  const comuns = new Map();
  for (const set of porVertice.values()) {
    if (set.size < 2) continue;
    const arr = [...set];
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const k = arr[a] < arr[b] ? `${arr[a]}|${arr[b]}` : `${arr[b]}|${arr[a]}`;
        comuns.set(k, (comuns.get(k) || 0) + 1);
      }
    }
  }
  const vizinhos = Object.fromEntries(paths.map(([, c]) => [c, new Set()]));
  const ligar = (minimo, apenasIsolados) => {
    for (const [k, n] of comuns) {
      if (n < minimo) continue;
      const [a, b] = k.split("|");
      if (apenasIsolados && vizinhos[a].size && vizinhos[b].size) continue;
      vizinhos[a].add(b);
      vizinhos[b].add(a);
    }
  };
  ligar(2, false);
  ligar(1, true);
  const saida = Object.fromEntries(Object.entries(vizinhos).map(([c, s]) => [c, [...s].map(Number).sort()]));
  const isolados = Object.entries(saida).filter(([, v]) => !v.length).map(([c]) => c);
  fs.writeFileSync(path.join(DADOS, "vizinhos_PR_SC.json"), JSON.stringify(saida) + "\n");
  const arestas = Object.values(saida).reduce((s, v) => s + v.length, 0) / 2;
  console.log(`vizinhos_PR_SC.json: ${Object.keys(saida).length} municípios, ${arestas} vizinhanças` +
    (isolados.length ? `, ⚠ sem vizinho: ${isolados.join(", ")}` : ""));
}

if (process.argv.includes("--so-vizinhos")) {
  gerarVizinhos(fs.readFileSync(path.join(DADOS, "mapa_PR_SC.svg"), "utf8"));
  process.exit(0);
}

(async () => {
  fs.mkdirSync(DADOS, { recursive: true });

  // 1) Municípios de PR e SC com código IBGE
  const prsc = [];
  for (const [codigo, uf] of Object.entries(UFS)) {
    const lista = await baixar(`${IBGE_LOCALIDADES}/estados/${codigo}/municipios`);
    for (const m of lista) prsc.push({ codigo: m.id, uf, nome: m.nome });
  }
  prsc.sort((a, b) => a.codigo - b.codigo);
  fs.writeFileSync(path.join(DADOS, "municipios_ibge_PR_SC.json"), JSON.stringify(prsc, null, 1) + "\n");
  console.log(`municipios_ibge_PR_SC.json: ${prsc.length} municípios`);

  // 2) Todos os municípios do Brasil (nome + UF), para reconhecer cidade de outro estado
  const brasil = (await baixar(`${IBGE_LOCALIDADES}/municipios`))
    .map((m) => ({ nome: m.nome, uf: ufDoMunicipio(m) }))
    .filter((m) => m.uf)
    .sort((a, b) => a.uf.localeCompare(b.uf) || a.nome.localeCompare(b.nome));
  fs.writeFileSync(path.join(DADOS, "municipios_brasil.json"), JSON.stringify(brasil) + "\n");
  console.log(`municipios_brasil.json: ${brasil.length} municípios`);

  // 3) Malha municipal fundida
  const malhas = [];
  for (const codigo of Object.keys(UFS)) {
    const svg = await baixar(
      `${IBGE_MALHAS}/${codigo}?formato=image/svg+xml&qualidade=minima&intrarregiao=municipio`,
      true
    );
    const m = extrairMalha(svg, codigo);
    m.codigoUf = codigo;
    malhas.push(m);
    console.log(`malha UF ${codigo}: ${m.qtde} paths, viewBox ${m.x} ${m.y} ${m.w} ${m.h}`);
  }
  if (new Set(malhas.map((m) => m.transform)).size !== 1) {
    throw new Error("as malhas não compartilham o mesmo transform — não dá para fundir por concatenação");
  }
  const x0 = Math.min(...malhas.map((m) => m.x));
  const y0 = Math.min(...malhas.map((m) => m.y));
  const x1 = Math.max(...malhas.map((m) => m.x + m.w));
  const y1 = Math.max(...malhas.map((m) => m.y + m.h));
  const arred = (n) => Number(n.toFixed(4));
  const svgFinal =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${arred(x0)} ${arred(y0)} ${arred(x1 - x0)} ${arred(y1 - y0)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">\n` +
    malhas
      .map((m) => `<g id="UF${m.codigoUf}" data-uf="${UFS[m.codigoUf]}" transform="${m.transform}">${m.paths}</g>`)
      .join("\n") +
    `\n</svg>\n`;
  fs.writeFileSync(path.join(DADOS, "mapa_PR_SC.svg"), svgFinal);
  console.log(`mapa_PR_SC.svg: ${(svgFinal.length / 1024).toFixed(0)} KB, ${malhas.reduce((s, m) => s + m.qtde, 0)} paths`);
  gerarVizinhos(svgFinal);

  // Conferência: todo município da lista tem path na malha e vice-versa
  const ids = new Set([...svgFinal.matchAll(/<path id="m(\d+)"/g)].map((x) => Number(x[1])));
  const semPath = prsc.filter((m) => !ids.has(m.codigo));
  const semLista = [...ids].filter((c) => !prsc.some((m) => m.codigo === c));
  if (semPath.length || semLista.length) {
    console.warn(`⚠ sem path na malha: ${semPath.map((m) => m.nome).join(", ") || "—"}; ` +
      `paths sem município na lista: ${semLista.join(", ") || "—"}`);
  } else {
    console.log("conferência: lista e malha batem 1:1");
  }
})().catch((err) => {
  console.error("✖", err.message || err);
  process.exit(1);
});
