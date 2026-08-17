import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const QUESTIONS_COL = "questions";
const SIM_THRESHOLD = 0.70;

const DOMAIN_CODE = {
  "의사소통능력":"COM","수리능력":"NUM","문제해결능력":"PSV","자원관리능력":"RES","기술능력":"TEC",
  "자기개발능력":"SDV","대인관계능력":"INT","정보능력":"INF","조직이해능력":"ORG","직업윤리":"ETH"
};
const DOMAIN_COLORS = {
  "의사소통능력":{c:"var(--d1)",bg:"var(--d1-bg)"},"수리능력":{c:"var(--d2)",bg:"var(--d2-bg)"},
  "문제해결능력":{c:"var(--d3)",bg:"var(--d3-bg)"},"자원관리능력":{c:"var(--d4)",bg:"var(--d4-bg)"},
  "기술능력":{c:"var(--d5)",bg:"var(--d5-bg)"},"자기개발능력":{c:"var(--d6)",bg:"var(--d6-bg)"},
  "대인관계능력":{c:"var(--d7)",bg:"var(--d7-bg)"},"정보능력":{c:"var(--d8)",bg:"var(--d8-bg)"},
  "조직이해능력":{c:"var(--d9)",bg:"var(--d9-bg)"},"직업윤리":{c:"var(--d10)",bg:"var(--d10-bg)"}
};

let allQuestions = [];      // live cache from Firestore onSnapshot
let currentList = [];
let detailIdx = 0;
let selectedIds = new Set();

// ---------- similarity ----------
function normalize(s){ return (s||"").replace(/\s+/g,"").replace(/[.,!?()\[\]{}'"“”·※\-–—:;=]/g,"").toLowerCase(); }
function bigramCounts(s){
  const t = normalize(s); const m = new Map();
  for(let i=0;i<t.length-1;i++){ const g=t.substr(i,2); m.set(g,(m.get(g)||0)+1); }
  return m;
}
function diceSim(a,b){
  const ga=bigramCounts(a), gb=bigramCounts(b);
  if(ga.size===0||gb.size===0) return 0;
  let inter=0;
  for(const [g,c] of ga){ if(gb.has(g)) inter+=Math.min(c,gb.get(g)); }
  const ta=[...ga.values()].reduce((x,y)=>x+y,0), tb=[...gb.values()].reduce((x,y)=>x+y,0);
  return (2*inter)/(ta+tb);
}
function combinedText(q){ return (q.stem||"")+" "+(q.passage||""); }

function imageIdsOf(imgArr){
  return (imgArr||[]).map(u=>extractDriveId(u) || u).filter(Boolean);
}
function combinedSimilarity(newText, newImages, q){
  return diceSim(newText, combinedText(q));
}

// ---------- auth ----------
const loginOverlay = document.getElementById("loginOverlay");
const appRoot = document.getElementById("appRoot");
const loginError = document.getElementById("loginError");

document.getElementById("loginBtn").addEventListener("click", async ()=>{
  const email = document.getElementById("loginEmail").value.trim();
  const pw = document.getElementById("loginPw").value;
  loginError.textContent = "";
  try{
    await signInWithEmailAndPassword(auth, email, pw);
  }catch(e){
    loginError.textContent = "로그인 실패: 이메일/비밀번호를 확인해주세요.";
  }
});
document.getElementById("logoutBtn").addEventListener("click", ()=> signOut(auth));

onAuthStateChanged(auth, (user)=>{
  if(user){
    loginOverlay.style.display = "none";
    appRoot.style.display = "block";
    document.getElementById("userEmailTag").textContent = user.email;
    startListening();
  } else {
    loginOverlay.style.display = "flex";
    appRoot.style.display = "none";
  }
});

// ---------- firestore live sync ----------
let unsub = null;
function startListening(){
  if(unsub) return;
  const q = query(collection(db, QUESTIONS_COL), orderBy("id"));
  unsub = onSnapshot(q, (snap)=>{
    allQuestions = snap.docs.map(d=>d.data()).filter(x=>!x.deleted);
    renderTable();
  });
}

function nextIdFor(domain){
  const code = DOMAIN_CODE[domain] || "ETC";
  const nums = allQuestions.filter(q=>q.id.startsWith(code+"-"))
    .map(q=>parseInt(q.id.split("-")[1],10)).filter(n=>!isNaN(n));
  const maxN = nums.length ? Math.max(...nums) : 0;
  return code+"-"+String(maxN+1).padStart(4,"0");
}

// 문항의 영역을 바꿔도 ID 앞자리(영역 코드)는 처음 만들어질 때 값 그대로 남아있는다.
// (Firestore는 문서 ID를 그 자리에서 바로 못 바꾸기 때문에, 새 ID로 문서를 새로 만들고
//  기존 데이터를 그대로 옮긴 뒤, 예전 ID는 삭제 처리하는 방식으로 "재발급"한다.)
function idMatchesDomain(q){
  const code = DOMAIN_CODE[q.domain];
  return code && q.id.startsWith(code+"-");
}
async function reassignQuestionId(q){
  const newId = nextIdFor(q.domain);
  const newData = { ...q, id: newId, updatedAt: Date.now() };
  delete newData.deleted;
  await setDoc(doc(db, QUESTIONS_COL, newId), { ...newData, deleted:false });
  await updateDoc(doc(db, QUESTIONS_COL, q.id), { deleted: true, updatedAt: Date.now() });
  return newId;
}

function extractDriveId(url){
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/d\/([a-zA-Z0-9_-]+)/];
  for(const p of patterns){ const m = url.match(p); if(m) return m[1]; }
  return null;
}
function toViewableImageUrl(url){
  const id = extractDriveId(url);
  if(id) return `https://drive.google.com/uc?export=view&id=${id}`;
  return url;
}

// ---- table/chart data (comma or tab separated, first row = header) ----
function parseGridData(raw){
  const lines = (raw||"").trim().split("\n").map(l=>l.trim()).filter(l=>l);
  if(lines.length===0) return null;
  const rows = lines.map(l => l.split(/\t|,/).map(c=>c.trim()));
  return rows; // rows[0] = header
}

// 표 데이터를 넣으면, CBT에서 쓰는 것과 같은 스타일(남색 헤더/테두리/가운데정렬)의
// <style>+<table> HTML을 그대로 생성한다. 렌더링에 쓰는 동시에 "코드 복사" 버튼으로
// CBT 등 다른 곳에 그대로 붙여넣을 수 있게 원본 코드 문자열도 함께 돌려준다.
function generateTableHtml(header, dataRows, uid){
  const cls = "ncsTable_" + uid.replace(/[^a-zA-Z0-9]/g, "");
  const nl2br = s => (s||"").replace(/\\n/g, "<br>");
  const css =
`<style>
  .${cls} {
    width:100%;
    table-layout:fixed;
    border-collapse:collapse;
    color:#111;
    font-size:15px;
    line-height:1.5;
  }
  .${cls} th,
  .${cls} td {
    padding:13px 8px;
    border:1px solid #777;
    text-align:center;
    vertical-align:middle;
    white-space:normal !important;
    word-break:keep-all;
  }
  .${cls} thead th {
    background:#082d57 !important;
    color:#fff !important;
    font-weight:700;
  }
  .${cls} tbody td:first-child {
    font-weight:700;
  }
  @media (max-width:700px) {
    .${cls} { font-size:12px; }
    .${cls} th, .${cls} td { padding:9px 4px; }
  }
</style>`;
  const theadRow = "      " + header.map(h=>"<th>"+nl2br(h)+"</th>").join("\n      ");
  const tbodyRows = dataRows.map(r =>
    "    <tr>\n      " + r.map(c=>"<td>"+nl2br(c)+"</td>").join("\n      ") + "\n    </tr>"
  ).join("\n");
  const table =
`<table class="${cls}">
  <thead>
    <tr>
${theadRow}
    </tr>
  </thead>
  <tbody>
${tbodyRows}
  </tbody>
</table>`;
  return css + "\n" + table;
}

function addCopyButton(wrap, htmlCode){
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "코드 복사";
  btn.style.cssText = "margin-top:6px;font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid var(--line);background:#F1F3F8;color:var(--muted);cursor:pointer;";
  btn.addEventListener("click", ()=>{
    navigator.clipboard.writeText(htmlCode).then(()=>{
      btn.textContent = "복사됨 ✓";
      setTimeout(()=>{ btn.textContent = "코드 복사"; }, 1500);
    });
  });
  wrap.appendChild(btn);
}

const PALETTE = ["#4C5FD5","#1F9A8D","#D98E2A","#C1546B","#6B5CA5","#3E8FB0","#B0703E","#5C8A3E"];

let activeChartInstances = [];
function renderChartBox(q){
  const box = document.getElementById("chartBox");
  if(!box) return;
  activeChartInstances.forEach(c=>c.destroy());
  activeChartInstances = [];
  box.innerHTML = "";

  const blocks = q.dataBlocks && q.dataBlocks.length ? q.dataBlocks : [];
  if(!blocks.length) return;

  blocks.forEach((block, idx)=>{
    const rows = parseGridData(block.raw);
    if(!rows || rows.length < 2) return;
    const header = rows[0];
    const dataRows = rows.slice(1);
    const titleHtml = block.title ? '<div class="dataTitle">'+block.title+'</div>' : "";
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "16px";
    box.appendChild(wrap);

    if(block.type === "table"){
      const tableCode = generateTableHtml(header, dataRows, q.id+"_"+idx);
      wrap.innerHTML = titleHtml + tableCode;
      addCopyButton(wrap, tableCode);
      return;
    }

    if(!window.Chart) return;
    const canvasId = "chartCanvas_"+idx;

    if(block.type === "pie"){
      const labels = dataRows.map(r=>r[0]);
      const values = dataRows.map(r=>parseFloat(r[1]) || 0);
      wrap.innerHTML = titleHtml + '<div class="chartWrap"><canvas id="'+canvasId+'" height="220"></canvas></div>';
      const ctx = document.getElementById(canvasId).getContext("2d");
      activeChartInstances.push(new Chart(ctx, {
        type: "pie",
        data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_,i)=>PALETTE[i%PALETTE.length]) }] },
        options: { responsive:true, plugins:{ legend:{ display:true, position:"right" } } }
      }));
      return;
    }

    if(block.type === "bar" || block.type === "line"){
      const categories = dataRows.map(r=>r[0]);
      const seriesNames = header.slice(1);
      const datasets = seriesNames.map((name,i)=>({
        label: name,
        data: dataRows.map(r=>parseFloat(r[i+1]) || 0),
        backgroundColor: PALETTE[i%PALETTE.length],
        borderColor: PALETTE[i%PALETTE.length],
        fill: false
      }));
      wrap.innerHTML = titleHtml + '<div class="chartWrap"><canvas id="'+canvasId+'" height="220"></canvas></div>';
      const ctx = document.getElementById(canvasId).getContext("2d");
      activeChartInstances.push(new Chart(ctx, {
        type: block.type,
        data: { labels: categories, datasets },
        options: { responsive:true, plugins:{ legend:{ display: seriesNames.length>1 } } }
      }));
    }
  });
}

async function addNew(form){
  const id = nextIdFor(form.domain);
  const docData = {
    id, domain: form.domain, stem: form.stem, passage: form.passage,
    choices: form.choices, source: form.source || "그릿마인드랩 자체 제작",
    images: form.images||[], usageLog: form.usageLog||[], dataBlocks: form.dataBlocks||[],
    answer: form.answer, difficulty: form.difficulty, type: form.type || "미정", subType: form.subType || "",
    needsImage: !!form.needsImage,
    examQuestionNumber: (form.examQuestionNumber===undefined ? null : form.examQuestionNumber),
    explanation: form.explanation || "",
    version: 1, history: [], deleted: false,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await setDoc(doc(db, QUESTIONS_COL, id), docData);
  return id;
}

function normalizeForCompare(s){ return (s||"").replace(/\s+/g,"").trim(); }
// 내용이 실제로 달라진 게 있는지 확인한다 (공백 차이는 무시).
// 정답/난이도/유형처럼 부가정보만 바뀐 건 여기서 보지 않고, "문제 자체"(발문/지문/보기/정답)만 비교한다.
function isSameQuestionContent(form, prev){
  if(normalizeForCompare(form.stem) !== normalizeForCompare(prev.stem)) return false;
  if(normalizeForCompare(form.passage) !== normalizeForCompare(prev.passage)) return false;
  const fc = (form.choices||[]).map(normalizeForCompare).join("|");
  const pc = (prev.choices||[]).map(normalizeForCompare).join("|");
  if(fc !== pc) return false;
  if(normalizeForCompare(form.answer) !== normalizeForCompare(prev.answer||"")) return false;
  return true;
}

// id 문항을 form 내용으로 덮어쓴다. 내용이 실제로(발문/지문/보기/정답 기준) 달라졌을 때만
// 버전을 올리고 이전 내용을 이력에 남긴다 — 완전히 같은 내용을 다시 등록한 경우(예: 같은 문제를
// 다른 출처/사용이력으로만 추가한 경우)에는 버전이 그대로 유지된다.
// 반환값 { versioned: true/false } 로 호출부에서 적절한 안내 메시지를 보여줄 수 있다.
// id 문항을 form 내용으로 덮어쓴다.
// forceVersion이 지정되면(true/false) 그 값을 그대로 따르고, 지정하지 않으면(undefined)
// 내용이 실제로(발문/지문/보기/정답 기준) 달라졌는지 자동으로 비교해서 판단한다.
async function applyReplace(id, form, forceVersion){
  const prevSnap = await getDoc(doc(db, QUESTIONS_COL, id));
  const prev = prevSnap.data();
  const versioned = (forceVersion !== undefined) ? forceVersion : !isSameQuestionContent(form, prev);

  const patch = {
    stem: form.stem, passage: form.passage, choices: form.choices,
    source: form.source || prev.source, images: form.images||[], dataBlocks: form.dataBlocks||[],
    usageLog: form.usageLog||[],
    answer: form.answer, difficulty: form.difficulty, type: form.type, subType: form.subType,
    updatedAt: Date.now()
  };

  if(versioned){
    const history = prev.history || [];
    history.push({
      stem:prev.stem, passage:prev.passage, choices:prev.choices, answer:prev.answer,
      difficulty:prev.difficulty, type:prev.type, subType:prev.subType, images:prev.images, replacedAt: Date.now()
    });
    patch.version = (prev.version||1)+1;
    patch.history = history;
  }

  await updateDoc(doc(db, QUESTIONS_COL, id), patch);
  return { versioned };
}

async function deleteQuestion(id){
  await updateDoc(doc(db, QUESTIONS_COL, id), { deleted: true, updatedAt: Date.now() });
}

function parseExplanationText(rawText){
  const lines = (rawText||"").split("\n").map(l=>l.trim()).filter(l=>l);
  const result = {};
  let curNum = null;
  let curLines = [];
  function flush(){
    if(curNum!==null && curLines.length){
      result[curNum] = curLines.join("\n").trim();
    }
  }
  lines.forEach(line=>{
    const m = line.match(/^(\d{1,3})[.\)]\s*(.*)$/);
    if(m){
      flush();
      curNum = parseInt(m[1],10);
      curLines = m[2] ? [m[2]] : [];
    } else if(curNum!==null){
      curLines.push(line);
    }
  });
  flush();
  return result;
}

async function addUsageToExisting(existingId, usage){
  const snap = await getDoc(doc(db, QUESTIONS_COL, existingId));
  if(!snap.exists()) return false;
  const prev = snap.data();
  const usageLog = (prev.usageLog||[]).slice();
  usageLog.push(usage);
  await updateDoc(doc(db, QUESTIONS_COL, existingId), { usageLog, updatedAt: Date.now() });
  return true;
}

// ---------- one-time seed import ----------
document.getElementById("seedImportBtn").addEventListener("click", async ()=>{
  if(!confirm("초기 시드 문제(50문항)를 불러올까요? 이미 있는 ID는 건너뜁니다.")) return;
  const res = await fetch("./seed-questions.json");
  const seed = await res.json();
  let count = 0;
  for(const q of seed){
    const existing = await getDoc(doc(db, QUESTIONS_COL, q.id));
    if(existing.exists()) continue;
    await setDoc(doc(db, QUESTIONS_COL, q.id), {
      ...q, images: q.images||[], answer:"", difficulty:"미정", version:1, history:[],
      deleted:false, createdAt: Date.now(), updatedAt: Date.now()
    });
    count++;
  }
  alert(count + "개 문항을 가져왔습니다.");
});

// ---------- rendering (table / detail) ----------
function renderStats(){
  const byDomain = {};
  allQuestions.forEach(q=>{ byDomain[q.domain]=(byDomain[q.domain]||0)+1; });
  const curDomain = document.getElementById("domainFilter").value;
  let html = '<button type="button" class="statchip'+(curDomain===""?" active":"")+'" data-statdom="">전체 <b>'+allQuestions.length+'</b>문항</button>';
  Object.keys(byDomain).forEach(dom=>{
    html += '<button type="button" class="statchip'+(curDomain===dom?" active":"")+'" data-statdom="'+dom+'">'+dom+' <b>'+byDomain[dom]+'</b></button>';
  });
  document.getElementById("statrow").innerHTML = html;
  document.getElementById("totalCount").textContent = allQuestions.length;

  const idListEl = document.getElementById("existingQIdList");
  if(idListEl){
    idListEl.innerHTML = allQuestions.map(q=>
      '<option value="'+q.id+'">'+q.id+' — '+(q.stem||"").slice(0,30).replace(/"/g,'&quot;')+'</option>'
    ).join('');
  }

  const domSel = document.getElementById("domainFilter");
  const cur = domSel.value;
  domSel.innerHTML = '<option value="">영역 전체</option>' + Object.keys(DOMAIN_CODE).map(d=>'<option>'+d+'</option>').join('');
  domSel.value = cur;

  const srcSel = document.getElementById("sourceFilter");
  const curSrc = srcSel.value;
  const distinctSources = [...new Set(allQuestions.map(q=>q.source).filter(Boolean))].sort();
  srcSel.innerHTML = '<option value="">출처(모의고사) 전체</option>' + distinctSources.map(s=>'<option value="'+s.replace(/"/g,'&quot;')+'">'+s+'</option>').join('');
  srcSel.value = curSrc;

  document.getElementById("statrow").querySelectorAll("button[data-statdom]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const dom = btn.getAttribute("data-statdom");
      document.getElementById("domainFilter").value = dom;
      const detailVisible = document.getElementById("detailView").style.display !== "none";
      if(detailVisible){
        currentList = getFiltered();
        detailIdx = 0;
        if(currentList.length===0){ alert("이 영역에 해당하는 문제가 없습니다."); }
        renderDetail();
        renderStats();
      } else {
        renderTable();
      }
    });
  });
}

function getFiltered(){
  const q = document.getElementById("searchBox").value.trim().toLowerCase();
  const dom = document.getElementById("domainFilter").value;
  const src = document.getElementById("sourceFilter").value;
  const diff = document.getElementById("diffFilter").value;
  const type = document.getElementById("typeFilter").value;
  const imgNeed = document.getElementById("imgNeedFilter").value;
  let list = allQuestions.slice();
  if(dom) list = list.filter(x=>x.domain===dom);
  if(src) list = list.filter(x=>x.source===src);
  if(diff) list = list.filter(x=>(x.difficulty||"미정")===diff);
  if(type) list = list.filter(x=>(x.type||"미정")===type);
  if(imgNeed==="needed") list = list.filter(x=>x.needsImage && (x.images||[]).length===0);
  if(q) list = list.filter(x => (x.id+" "+x.stem+" "+(x.passage||"")+" "+(x.source||"")+" "+(x.type||"")+" "+(x.subType||"")).toLowerCase().includes(q));
  if(src){
    list.sort((a,b)=>{
      const na = a.examQuestionNumber!=null ? a.examQuestionNumber : Infinity;
      const nb = b.examQuestionNumber!=null ? b.examQuestionNumber : Infinity;
      return na - nb;
    });
  }
  return list;
}

function renderTable(){
  renderStats();
  const list = getFiltered();
  const allIds = new Set(allQuestions.map(q=>q.id));
  selectedIds.forEach(id=>{ if(!allIds.has(id)) selectedIds.delete(id); });

  const tbody = document.getElementById("tbody");
  if(list.length===0){
    tbody.innerHTML = '<tr><td colspan="12"><div class="emptyrow">조건에 맞는 문제가 없습니다.</div></td></tr>';
    renderBulkBar();
    return;
  }
  tbody.innerHTML = list.map(q=>{
    const col = DOMAIN_COLORS[q.domain] || {c:'#888',bg:'#eee'};
    const stemShort = (q.stem||"").slice(0,45) + ((q.stem||"").length>45?"…":"");
    const imgCount = (q.images||[]).length;
    const usage = q.usageLog||[];
    const usageShort = usage.length ? usage.map(u=>u.institution).filter(Boolean).join(', ') : '-';
    const checked = selectedIds.has(q.id) ? 'checked' : '';
    return '<tr>'+
      '<td><input type="checkbox" class="rowCheck" data-id="'+q.id+'" '+checked+'></td>'+
      '<td class="idcell">'+q.id+'</td>'+
      '<td><span class="domchip" style="color:'+col.c+';background:'+col.bg+'">'+q.domain+'</span></td>'+
      '<td>'+ (q.type||"미정") +'</td>'+
      '<td style="font-size:12px;color:var(--muted);">'+ (q.subType||"-") +'</td>'+
      '<td class="stemcell" title="'+ (q.stem||"").replace(/"/g,'&quot;') +'">'+stemShort+'</td>'+
      '<td>'+ (q.difficulty||"미정") +'</td>'+
      '<td class="idcell">'+ (q.answer||"-") +'</td>'+
      '<td style="font-size:11.5px;color:var(--muted);">'+ (q.source||"-") +'</td>'+
      '<td style="font-size:11.5px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+usageShort.replace(/"/g,'&quot;')+'">'+usageShort+'</td>'+
      '<td class="imgbadge">'+ (imgCount>0 ? ('🖼 '+imgCount) : (q.needsImage ? '<span style="color:var(--warn);font-weight:700;">⚠ 필요</span>' : '-')) +'</td>'+
      '<td class="actioncell">'+
        '<button class="btn small ghost" data-act="view" data-id="'+q.id+'">보기</button>'+
        '<button class="btn small ghost" data-act="edit" data-id="'+q.id+'">편집</button>'+
        '<button class="btn small danger" data-act="del" data-id="'+q.id+'">삭제</button>'+
      '</td></tr>';
  }).join('');

  tbody.querySelectorAll("button[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if(act==="view") openDetailFor(id);
      if(act==="edit") openEditFor(id);
      if(act==="del"){
        if(confirm(id+" 문항을 삭제할까요? (전체 팀원 공용 데이터에서 삭제됩니다)")) deleteQuestion(id);
      }
    });
  });
  tbody.querySelectorAll("input.rowCheck").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const id = cb.getAttribute("data-id");
      if(cb.checked) selectedIds.add(id); else selectedIds.delete(id);
      renderBulkBar();
      updateSelectAllState(list);
    });
  });
  updateSelectAllState(list);
  renderBulkBar();
}

function updateSelectAllState(list){
  const box = document.getElementById("selectAllBox");
  if(!list.length){ box.checked=false; box.indeterminate=false; return; }
  const selCount = list.filter(q=>selectedIds.has(q.id)).length;
  box.checked = selCount === list.length;
  box.indeterminate = selCount>0 && selCount<list.length;
}
document.getElementById("selectAllBox").addEventListener("change", (e)=>{
  const list = getFiltered();
  if(e.target.checked) list.forEach(q=>selectedIds.add(q.id));
  else list.forEach(q=>selectedIds.delete(q.id));
  renderTable();
});

function renderBulkBar(){
  const bar = document.getElementById("bulkBar");
  const count = selectedIds.size;
  document.getElementById("bulkCount").textContent = count;
  bar.style.display = count>0 ? "flex" : "none";
}
document.getElementById("bulkClearBtn").addEventListener("click", ()=>{
  selectedIds.clear();
  renderTable();
});
document.getElementById("bulkDeleteBtn").addEventListener("click", async ()=>{
  if(!confirm(selectedIds.size+"개 문항을 삭제할까요? (팀 전체 공용 데이터에서 삭제됩니다)")) return;
  for(const id of Array.from(selectedIds)){ await deleteQuestion(id); }
  selectedIds.clear();
  renderTable();
});

document.getElementById("searchApplyBtn").addEventListener("click", renderTable);
document.getElementById("searchBox").addEventListener("keydown", (e)=>{ if(e.key==="Enter") renderTable(); });

// ---------- view toggle ----------
document.getElementById("viewListBtn").addEventListener("click", async ()=>{
  await flushDetailEdits();
  document.getElementById("listView").style.display="block";
  document.getElementById("detailView").style.display="none";
  document.getElementById("viewListBtn").classList.add("active");
  document.getElementById("viewDetailBtn").classList.remove("active");
});
document.getElementById("viewDetailBtn").addEventListener("click", ()=>{
  currentList = getFiltered();
  if(currentList.length===0){ alert("표시할 문제가 없습니다."); return; }
  detailIdx = 0;
  showDetailView();
});
function showDetailView(){
  document.getElementById("listView").style.display="none";
  document.getElementById("detailView").style.display="block";
  document.getElementById("viewListBtn").classList.remove("active");
  document.getElementById("viewDetailBtn").classList.add("active");
  renderDetail();
}
function openDetailFor(id){
  currentList = getFiltered();
  const i = currentList.findIndex(q=>q.id===id);
  detailIdx = i>=0 ? i : 0;
  showDetailView();
}

function autoResize(el){
  if(!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function renderDetail(){
  const q = currentList[detailIdx];
  if(!q) return;
  document.getElementById("qnumLabel").textContent = "문항 "+(detailIdx+1)+" / "+currentList.length;
  document.getElementById("detailPos").textContent = (detailIdx+1)+"/"+currentList.length;
  const col = DOMAIN_COLORS[q.domain]||{c:"var(--primary-2)",bg:"#eee"};
  const chip = document.getElementById("domainChip");
  chip.textContent=q.domain; chip.style.color=col.c; chip.style.background=col.bg;
  document.getElementById("qid").textContent=q.id;
  document.getElementById("idMismatchBox").style.display = idMatchesDomain(q) ? "none" : "block";
  document.getElementById("domainSelect").value = q.domain;
  document.getElementById("qsource").textContent=q.source||"-";
  const usageBox = document.getElementById("qUsageList");
  const usage = q.usageLog||[];
  usageBox.innerHTML = usage.length
    ? usage.map(u=>'<div>'+ [u.institution, u.when, u.grade].filter(Boolean).join(' · ') +'</div>').join('')
    : '-';
  const stemEl = document.getElementById("stemText");
  stemEl.value = q.stem||"";
  autoResize(stemEl);
  renderImagesBox(q);
  renderChartBox(q);
  const passageBox = document.getElementById("passageBox");
  passageBox.value = q.passage||"";
  autoResize(passageBox);
  const explanationBox = document.getElementById("explanationBox");
  explanationBox.value = q.explanation||"";
  autoResize(explanationBox);
  const list = document.getElementById("choicesList"); list.innerHTML="";
  const marks=['①','②','③','④','⑤'];
  (q.choices||[]).forEach((c,i)=>{
    const li=document.createElement("li");
    const span=document.createElement("span"); span.className="cnum"; span.textContent=marks[i]||"";
    const ta=document.createElement("textarea"); ta.rows=1; ta.value=c; ta.dataset.cidx=String(i); ta.setAttribute("readonly","");
    li.appendChild(span); li.appendChild(ta);
    list.appendChild(li);
    autoResize(ta);
  });
  document.getElementById("diffSelect").value = q.difficulty||"미정";
  document.getElementById("typeSelect").value = q.type||"미정";
  document.getElementById("subTypeInput").value = q.subType||"";
  document.getElementById("answerInput").value = q.answer||"";
  document.getElementById("examNumInput").value = (q.examQuestionNumber!=null ? q.examQuestionNumber : "");
  document.getElementById("versionTag").textContent = q.version&&q.version>1 ? ("v"+q.version+" · 이전 버전 "+(q.history?q.history.length:0)+"건 보관") : "";
  document.getElementById("prevBtn").disabled = detailIdx===0;
  document.getElementById("nextBtn").disabled = detailIdx===currentList.length-1;
  setSaveStatus("", "");
  setDetailEditMode(false);
}

let detailEditMode = false;
function setDetailEditMode(on){
  detailEditMode = on;
  const stemEl = document.getElementById("stemText");
  const passageEl = document.getElementById("passageBox");
  const explanationEl = document.getElementById("explanationBox");
  const choiceTAs = document.getElementById("choicesList").querySelectorAll("textarea");
  const btn = document.getElementById("detailEditToggle");
  const note = document.getElementById("editModeNote");
  const maincard = document.getElementById("maincard");
  const imageAddBox = document.getElementById("detailImageAddBox");
  const manualReplaceBox = document.getElementById("detailManualReplaceBox");
  if(on){
    stemEl.removeAttribute("readonly");
    passageEl.removeAttribute("readonly");
    explanationEl.removeAttribute("readonly");
    choiceTAs.forEach(ta=>ta.removeAttribute("readonly"));
    if(btn){ btn.textContent = "✓ 편집 완료 (눌러서 저장)"; btn.classList.remove("outline"); btn.classList.add("primary"); }
    if(note) note.style.display = "inline-flex";
    if(maincard) maincard.classList.add("editing");
    if(imageAddBox) imageAddBox.style.display = "block";
    if(manualReplaceBox){
      manualReplaceBox.style.display = "block";
      const q = currentList[detailIdx];
      const selfIdEl = document.getElementById("detailManualReplaceSelfId");
      if(q && selfIdEl) selfIdEl.textContent = q.id;
    }
    stemEl.focus();
  } else {
    stemEl.setAttribute("readonly","");
    passageEl.setAttribute("readonly","");
    explanationEl.setAttribute("readonly","");
    choiceTAs.forEach(ta=>ta.setAttribute("readonly",""));
    if(btn){ btn.textContent = "✏️ 편집하기"; btn.classList.remove("primary"); btn.classList.add("outline"); }
    if(note) note.style.display = "none";
    if(maincard) maincard.classList.remove("editing");
    if(imageAddBox) imageAddBox.style.display = "none";
    if(manualReplaceBox) manualReplaceBox.style.display = "none";
  }
  if(currentList[detailIdx]) renderImagesBox(currentList[detailIdx]);
}

// 상세보기 편집모드에서 이미지 파일을 첨부하면(선택 또는 드래그앤드롭), 압축 후 완성된
// <img> HTML로 변환해서 바로 이 문항의 images 배열에 추가하고 Firestore에 저장한다.
// Firestore 문서 하나는 1MB 제한이 있어서, 사진/HTML을 계속 추가하다 보면 어느 순간
// 저장이 실패할 수 있다. 저장 시도 전에 대략적인 용량을 미리 계산해서 경고해준다.
function estimateDocSize(q, extraPatch){
  const merged = { ...q, ...extraPatch };
  return JSON.stringify(merged).length;
}
const DOC_SIZE_WARN_LIMIT = 900000; // Firestore 1MB 제한보다 여유 있게 낮춰서 미리 경고

async function handleDetailImageFiles(files){
  const statusEl = document.getElementById("detailImageFileStatus");
  const q = currentList[detailIdx];
  if(!q) return;
  const images = (q.images||[]).slice();
  for(const file of files){
    if(!file.type || !file.type.startsWith("image/")) continue;
    statusEl.textContent = "'"+file.name+"' 압축 중...";
    try{
      let dataUrl = await compressImageFile(file, 1000, 0.7);
      if(dataUrl.length > 700000){
        dataUrl = await compressImageFile(file, 800, 0.5);
      }
      const candidateImages = images.concat([buildImageHtml(dataUrl)]);
      if(estimateDocSize(q, { images: candidateImages }) > DOC_SIZE_WARN_LIMIT){
        statusEl.textContent = "⚠ '"+file.name+"' 추가하면 이 문항 데이터가 너무 커져서(1MB 제한) 저장이 안 돼요. 기존 이미지를 먼저 삭제하거나, 더 작은 사진으로 시도해주세요.";
        continue;
      }
      images.push(buildImageHtml(dataUrl));
      statusEl.textContent = "✓ 사진을 추가했어요 (약 "+Math.round(dataUrl.length/1024)+"KB).";
    }catch(err){
      console.error(err);
      statusEl.textContent = "'"+file.name+"' 처리에 실패했어요.";
    }
  }
  const ok = await saveDetailPatch({ images });
  if(!ok){
    statusEl.textContent = "⚠ 저장에 실패했어요 (이미지 용량이 너무 클 수 있어요). 기존 이미지를 정리한 뒤 다시 시도해주세요.";
    return;
  }
  renderImagesBox(q);
}

document.getElementById("detailImageFileInput").addEventListener("change", async (e)=>{
  await handleDetailImageFiles(Array.from(e.target.files));
  e.target.value = "";
});

const detailImageAddBox = document.getElementById("detailImageAddBox");
["dragenter","dragover"].forEach(evt=>{
  detailImageAddBox.addEventListener(evt, (e)=>{
    e.preventDefault(); e.stopPropagation();
    detailImageAddBox.classList.add("dragover");
  });
});
["dragleave","dragend"].forEach(evt=>{
  detailImageAddBox.addEventListener(evt, (e)=>{
    e.preventDefault(); e.stopPropagation();
    detailImageAddBox.classList.remove("dragover");
  });
});
detailImageAddBox.addEventListener("drop", async (e)=>{
  e.preventDefault(); e.stopPropagation();
  detailImageAddBox.classList.remove("dragover");
  const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
  if(files.length) await handleDetailImageFiles(files);
});

document.getElementById("detailAddHtmlImage").addEventListener("click", async ()=>{
  const input = document.getElementById("detailHtmlImageInput");
  const statusEl = document.getElementById("detailImageFileStatus");
  const code = input.value.trim();
  if(!code) return;
  const q = currentList[detailIdx];
  if(!q) return;
  const images = (q.images||[]).slice();
  const candidateImages = images.concat([code]);
  if(estimateDocSize(q, { images: candidateImages }) > DOC_SIZE_WARN_LIMIT){
    statusEl.textContent = "⚠ 이 코드를 추가하면 문항 데이터가 너무 커져서(1MB 제한) 저장이 안 돼요. 기존 이미지를 먼저 삭제해주세요.";
    return;
  }
  images.push(code); // 붙여넣은 HTML 코드를 그대로 저장
  input.value = "";
  const ok = await saveDetailPatch({ images });
  if(!ok){
    statusEl.textContent = "⚠ 저장에 실패했어요 (문항 데이터 용량이 너무 클 수 있어요). 기존 이미지를 정리한 뒤 다시 시도해주세요.";
    return;
  }
  statusEl.textContent = "✓ HTML 코드를 추가했어요.";
  renderImagesBox(q);
});

// 이미지 목록 + "이 문항은 그림/표가 있을 수 있어요" 경고 배너를 그려주는 공용 함수.
// 경고가 오탐(실제로는 이미지가 필요 없는 문항)인 경우, "확인" 버튼으로 needsImage를 꺼서
// 배너를 없앨 수 있게 한다.
// 자동 압축으로 등록된 단순 사진(<img ...> 한 줄)만 "사진"으로 보고 가운데 정렬 그룹에 넣는다.
// <style>, <div>, <table> 등이 섞인 커스텀 HTML 코드는 원래 레이아웃이 깨지지 않도록
// 별도 영역에 전체 너비/왼쪽 정렬로 표시한다.
function isSimplePhotoEntry(entry){
  return typeof entry === "string" && entry.trim().toLowerCase().startsWith("<img");
}

function renderImagesBox(q){
  const imgsBox = document.getElementById("imgsBox");
  const customBox = document.getElementById("customImgHtmlBox");
  const imgList = (q.images||[]);

  const photoEntries = [];   // {src, idx}
  const customEntries = [];  // {src, idx}
  imgList.forEach((src,i)=>{
    if(isSimplePhotoEntry(src)) photoEntries.push({src, idx:i});
    else customEntries.push({src, idx:i});
  });

  const delBtnAbs = (idx) => detailEditMode
    ? '<button type="button" data-delimg="'+idx+'" title="이 이미지 삭제" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:2px solid #fff;background:var(--danger);color:#fff;font-weight:700;font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25);">×</button>'
    : '';
  // 커스텀 HTML 블록은 폭이 넓거나 높이가 제각각이라, 절대위치로 겹쳐 놓으면 엉뚱한 위치(화면 우측
  // 상단)로 떨어져 보이는 문제가 있었다. 대신 블록 바로 위에 작은 인라인 버튼으로 붙인다.
  const delBtnInline = (idx) => detailEditMode
    ? '<button type="button" data-delimg="'+idx+'" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid var(--danger);background:var(--danger-bg);color:var(--danger);font-weight:700;cursor:pointer;margin-bottom:6px;">× 이 항목 삭제</button><br>'
    : '';

  let imgsHtml = photoEntries.map(({src,idx})=>
    '<div style="position:relative;display:inline-block;">'+ renderImageEntry(src) + delBtnAbs(idx) + '</div>'
  ).join('');

  if(q.needsImage && imgList.length===0){
    imgsHtml = '<div style="background:var(--warn-bg);color:var(--warn);font-weight:700;font-size:12.5px;padding:8px 12px;border-radius:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'+
      '<span>⚠ 이 문항은 원본에 그림/표가 있었을 가능성이 있어요 — "편집"에서 이미지를 추가해주세요.</span>'+
      '<button type="button" id="dismissNeedsImageBtn" style="border:1px solid var(--warn);background:#fff;color:var(--warn);font-weight:700;font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;flex-shrink:0;">✓ 확인 (이미지 필요 없음)</button>'+
      '</div>' + imgsHtml;
  }
  imgsBox.innerHTML = imgsHtml;

  customBox.innerHTML = customEntries.map(({src,idx})=>
    '<div class="customHtmlItem">'+ delBtnInline(idx) + src + '</div>'
  ).join('');

  const dismissBtn = document.getElementById("dismissNeedsImageBtn");
  if(dismissBtn){
    dismissBtn.addEventListener("click", async ()=>{
      await saveDetailPatch({ needsImage: false });
      renderImagesBox(currentList[detailIdx]);
    });
  }
  [imgsBox, customBox].forEach(container=>{
    container.querySelectorAll("button[data-delimg]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        if(!confirm("이 이미지를 삭제할까요?")) return;
        const idx = parseInt(btn.getAttribute("data-delimg"),10);
        const newImages = (currentList[detailIdx].images||[]).slice();
        newImages.splice(idx,1);
        const ok = await saveDetailPatch({ images: newImages });
        if(ok) renderImagesBox(currentList[detailIdx]);
      });
    });
  });
}

function setSaveStatus(txt, kind){
  const el = document.getElementById("detailSaveStatus");
  if(!el) return;
  el.textContent = txt || "";
  el.style.color = kind==="ok" ? "var(--ok)" : (kind==="err" ? "var(--danger)" : "var(--muted)");
}

async function saveDetailPatch(patch){
  const q = currentList[detailIdx];
  if(!q) return false;
  setSaveStatus("저장 중…", "saving");
  try{
    await updateDoc(doc(db, QUESTIONS_COL, q.id), { ...patch, updatedAt: Date.now() });
    Object.assign(q, patch); // Firestore 저장이 성공했을 때만 화면(로컬) 상태도 반영
    setSaveStatus("저장됨 ✓", "ok");
    return true;
  }catch(err){
    console.error(err);
    const sizeIssue = err && err.message && /longer than|exceeds|too large|invalid-argument/i.test(err.message);
    setSaveStatus(sizeIssue ? "저장 실패 — 문서 용량 초과" : "저장 실패 — 다시 시도해주세요", "err");
    return false;
  }
}

async function flushDetailEdits(){
  if(document.getElementById("detailView").style.display === "none") return;
  const q = currentList[detailIdx];
  if(!q) return;
  const patch = {};
  const domain = document.getElementById("domainSelect").value;
  const diff = document.getElementById("diffSelect").value;
  const type = document.getElementById("typeSelect").value;
  const subType = document.getElementById("subTypeInput").value.trim();
  const answer = document.getElementById("answerInput").value.trim();
  const examNumRaw = document.getElementById("examNumInput").value.trim();
  const examNum = examNumRaw ? parseInt(examNumRaw,10) : null;
  const stem = document.getElementById("stemText").value.trim();
  const passage = document.getElementById("passageBox").value.trim();
  const explanation = document.getElementById("explanationBox").value.trim();
  const choices = Array.from(document.getElementById("choicesList").querySelectorAll("textarea"))
    .map(ta=>ta.value.trim());
  if(domain !== q.domain) patch.domain = domain;
  if(diff !== (q.difficulty||"미정")) patch.difficulty = diff;
  if(type !== (q.type||"미정")) patch.type = type;
  if(subType !== (q.subType||"")) patch.subType = subType;
  if(answer !== (q.answer||"")) patch.answer = answer;
  if(examNum !== (q.examQuestionNumber!=null ? q.examQuestionNumber : null)) patch.examQuestionNumber = examNum;
  if(stem !== (q.stem||"")) patch.stem = stem;
  if(passage !== (q.passage||"")) patch.passage = passage;
  if(explanation !== (q.explanation||"")) patch.explanation = explanation;
  if(choices.length && JSON.stringify(choices) !== JSON.stringify(q.choices||[])) patch.choices = choices;
  if(Object.keys(patch).length) await saveDetailPatch(patch);
}

// 상세보기 편집모드에서 지금 입력창에 있는 값(저장 여부와 무관)을 그대로 읽어 form 객체로 만든다.
// "다른 문항 ID로 복사 등록" 버튼에서 사용 — 지금 화면에 보이는 편집 내용을 다른 문항에 덮어쓸 때 쓴다.
function readCurrentDetailAsForm(){
  const q = currentList[detailIdx];
  return {
    domain: document.getElementById("domainSelect").value,
    source: q ? (q.source||"") : "",
    stem: document.getElementById("stemText").value.trim(),
    passage: document.getElementById("passageBox").value.trim(),
    choices: Array.from(document.getElementById("choicesList").querySelectorAll("textarea")).map(ta=>ta.value.trim()),
    answer: document.getElementById("answerInput").value.trim(),
    difficulty: document.getElementById("diffSelect").value,
    type: document.getElementById("typeSelect").value,
    subType: document.getElementById("subTypeInput").value.trim(),
    images: q ? (q.images||[]) : []
  };
}
async function runDetailManualReplace(forceVersion){
  const targetId = document.getElementById("detailManualReplaceId").value.trim();
  const q = currentList[detailIdx];
  if(!q) return;
  if(!targetId){ alert("교체할 기존 문항 ID를 입력해주세요."); return; }
  if(targetId === q.id){ alert("지금 보고 있는 문항과 같은 ID예요. 다른 ID를 지정해주세요."); return; }
  const existing = allQuestions.find(x=>x.id===targetId);
  if(!existing){ alert("'"+targetId+"' ID를 가진 문항을 찾을 수 없어요. 정확한 ID인지 확인해주세요."); return; }
  const confirmMsg = forceVersion
    ? targetId+" 문항을 새 버전으로 교체할까요? ("+q.id+"는 그대로 남아있어요)"
    : targetId+" 문항에 동일 문제로 반영할까요? (버전 유지) — 같은 문제가 두 번 남지 않도록, 지금 보고 있는 "+q.id+"는 함께 삭제됩니다.";
  if(!confirm(confirmMsg)) return;
  const form = readCurrentDetailAsForm();
  const result = await applyReplace(targetId, form, forceVersion);
  if(!result.versioned){
    await deleteQuestion(q.id); // 동일 문제로 확인된 경우, 중복으로 남지 않도록 원본은 삭제 처리
    alert("✓ "+targetId+" 문항에 동일 문제로 반영했어요. (버전 유지, "+q.id+"는 삭제 처리됐어요)");
    document.getElementById("viewListBtn").click();
    return;
  }
  alert("✓ "+targetId+" 문항을 새 버전으로 교체했어요.");
  document.getElementById("detailManualReplaceId").value = "";
}
document.getElementById("detailManualReplaceSameBtn").addEventListener("click", ()=>runDetailManualReplace(false));
document.getElementById("detailManualReplaceVersionBtn").addEventListener("click", ()=>runDetailManualReplace(true));

document.getElementById("reassignIdBtn").addEventListener("click", async ()=>{
  const q = currentList[detailIdx];
  if(!q) return;
  const newId = nextIdFor(q.domain);
  if(!confirm("이 문항의 ID를 "+q.id+" → "+newId+" (으)로 바꿀까요?\n\n※ ID가 바뀌는 것뿐이고 내용(발문/보기/정답/이력 등)은 그대로 옮겨져요.\n※ 다른 곳에서 이 ID(" + q.id + ")를 참조하고 있었다면(예: 해설 매칭용 원문항번호는 영향 없음) 그 부분은 따로 확인이 필요해요.")) return;
  await reassignQuestionId(q);
  alert("✓ "+newId+"(으)로 재발급했어요.");
  document.getElementById("viewListBtn").click();
});

function ensureDetailSaveUI(){
  if(document.getElementById("detailSaveBtn")) return;
  const answer = document.getElementById("answerInput");
  if(!answer) return;
  const field = answer.closest(".field") || answer.parentElement;
  const btn = document.createElement("button");
  btn.id = "detailSaveBtn";
  btn.className = "btn primary small";
  btn.style.cssText = "width:100%;margin-top:4px;";
  btn.textContent = "저장";
  const status = document.createElement("div");
  status.id = "detailSaveStatus";
  status.style.cssText = "font-size:11px;font-family:var(--mono);color:var(--muted);text-align:center;margin-top:6px;min-height:14px;";
  field.insertAdjacentElement("afterend", btn);
  btn.insertAdjacentElement("afterend", status);
}
ensureDetailSaveUI();

document.getElementById("prevBtn").addEventListener("click", async ()=>{ if(detailIdx>0){ await flushDetailEdits(); detailIdx--; renderDetail(); } });
document.getElementById("nextBtn").addEventListener("click", async ()=>{ if(detailIdx<currentList.length-1){ await flushDetailEdits(); detailIdx++; renderDetail(); } });
document.getElementById("detailSaveBtn").addEventListener("click", async ()=>{ await flushDetailEdits(); setSaveStatus("저장됨 ✓", "ok"); });
document.getElementById("domainSelect").addEventListener("change", (e)=>{
  const newDomain = e.target.value;
  const col = DOMAIN_COLORS[newDomain]||{c:"var(--primary-2)",bg:"#eee"};
  const chip = document.getElementById("domainChip");
  chip.textContent = newDomain; chip.style.color = col.c; chip.style.background = col.bg;
  saveDetailPatch({ domain: newDomain });
});
document.getElementById("diffSelect").addEventListener("change", (e)=> saveDetailPatch({ difficulty: e.target.value }));
document.getElementById("typeSelect").addEventListener("change", (e)=> saveDetailPatch({ type: e.target.value }));
document.getElementById("subTypeInput").addEventListener("change", (e)=> saveDetailPatch({ subType: e.target.value.trim() }));
document.getElementById("answerInput").addEventListener("change", (e)=> saveDetailPatch({ answer: e.target.value.trim() }));
document.getElementById("examNumInput").addEventListener("change", (e)=>{
  const v = e.target.value.trim();
  saveDetailPatch({ examQuestionNumber: v ? parseInt(v,10) : null });
});

document.getElementById("stemText").addEventListener("input", (e)=> autoResize(e.target));
document.getElementById("stemText").addEventListener("change", (e)=> saveDetailPatch({ stem: e.target.value.trim() }));

document.getElementById("passageBox").addEventListener("input", (e)=> autoResize(e.target));
document.getElementById("passageBox").addEventListener("change", (e)=> saveDetailPatch({ passage: e.target.value.trim() }));

document.getElementById("explanationBox").addEventListener("input", (e)=> autoResize(e.target));
document.getElementById("explanationBox").addEventListener("change", (e)=> saveDetailPatch({ explanation: e.target.value.trim() }));

document.getElementById("choicesList").addEventListener("input", (e)=>{
  if(e.target.tagName==="TEXTAREA") autoResize(e.target);
});
document.getElementById("choicesList").addEventListener("change", (e)=>{
  if(e.target.tagName!=="TEXTAREA") return;
  const q = currentList[detailIdx];
  if(!q) return;
  const choices = Array.from(document.getElementById("choicesList").querySelectorAll("textarea"))
    .map(ta=>ta.value.trim());
  saveDetailPatch({ choices });
});

document.getElementById("detailEditToggle").addEventListener("click", async ()=>{
  if(detailEditMode){
    await flushDetailEdits();
    setDetailEditMode(false);
    setSaveStatus("저장됨 ✓", "ok");
  } else {
    setDetailEditMode(true);
  }
});

// ---------- bulk edit modal ----------
const overlayBulk = document.getElementById("overlayBulk");
document.getElementById("bulkEditBtn").addEventListener("click", ()=>{
  document.getElementById("bulkModalCount").textContent = selectedIds.size;
  document.getElementById("bulk_domain").value = "";
  document.getElementById("bulk_difficulty").value = "";
  document.getElementById("bulk_type").value = "";
  document.getElementById("bulk_subType").value = "";
  document.getElementById("bulk_source").value = "";
  ["bulk_usageInst","bulk_usageWhen","bulk_usageGrade"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("bulkResult").innerHTML = "";
  overlayBulk.classList.add("open");
});
document.getElementById("cancelBulk").addEventListener("click", ()=>overlayBulk.classList.remove("open"));
document.getElementById("closeXBulk").addEventListener("click", ()=>overlayBulk.classList.remove("open"));
overlayBulk.addEventListener("click", e=>{ if(e.target===overlayBulk) overlayBulk.classList.remove("open"); });

document.getElementById("applyBulk").addEventListener("click", async ()=>{
  const domain = document.getElementById("bulk_domain").value;
  const difficulty = document.getElementById("bulk_difficulty").value;
  const type = document.getElementById("bulk_type").value;
  const subType = document.getElementById("bulk_subType").value.trim();
  const source = document.getElementById("bulk_source").value.trim();
  const uInst = document.getElementById("bulk_usageInst").value.trim();
  const uWhen = document.getElementById("bulk_usageWhen").value.trim();
  const uGrade = document.getElementById("bulk_usageGrade").value.trim();
  const addUsage = uInst || uWhen || uGrade;

  if(!domain && !difficulty && !type && !subType && !source && !addUsage){
    document.getElementById("bulkResult").innerHTML = '<div class="dupBox"><b>변경할 항목을 하나 이상 입력해주세요.</b></div>';
    return;
  }

  let count = 0;
  for(const id of Array.from(selectedIds)){
    const q = allQuestions.find(x=>x.id===id);
    if(!q) continue;
    const patch = { updatedAt: Date.now() };
    if(domain) patch.domain = domain;
    if(difficulty) patch.difficulty = difficulty;
    if(type) patch.type = type;
    if(subType) patch.subType = subType;
    if(source) patch.source = source;
    if(addUsage){
      const usageLog = (q.usageLog||[]).slice();
      usageLog.push({institution:uInst, when:uWhen, grade:uGrade});
      patch.usageLog = usageLog;
    }
    await updateDoc(doc(db, QUESTIONS_COL, id), patch);
    count++;
  }
  document.getElementById("bulkResult").innerHTML = '<div class="okBox">✓ '+count+'개 문항이 일괄 수정되었습니다.</div>';
  setTimeout(()=>{ overlayBulk.classList.remove("open"); selectedIds.clear(); renderTable(); }, 900);
});

// ---------- 해설 일괄 입력 모달 ----------
const overlayExplain = document.getElementById("overlayExplain");
document.getElementById("openExplain").addEventListener("click", ()=>{
  const distinctSources = [...new Set(allQuestions.map(q=>q.source).filter(Boolean))].sort();
  const sel = document.getElementById("explain_source");
  const curFilterSrc = document.getElementById("sourceFilter").value;
  sel.innerHTML = distinctSources.map(s=>'<option'+(s===curFilterSrc?' selected':'')+'>'+s+'</option>').join('');
  document.getElementById("explainInput").value = "";
  document.getElementById("explainResult").innerHTML = "";
  overlayExplain.classList.add("open");
});
document.getElementById("cancelExplain").addEventListener("click", ()=>overlayExplain.classList.remove("open"));
document.getElementById("closeXExplain").addEventListener("click", ()=>overlayExplain.classList.remove("open"));
overlayExplain.addEventListener("click", e=>{ if(e.target===overlayExplain) overlayExplain.classList.remove("open"); });

document.getElementById("applyExplain").addEventListener("click", async ()=>{
  const source = document.getElementById("explain_source").value;
  const raw = document.getElementById("explainInput").value;
  const resBox = document.getElementById("explainResult");
  if(!source){ resBox.innerHTML = '<div class="dupBox"><b>출처(모의고사)를 선택해주세요.</b></div>'; return; }
  const parsed = parseExplanationText(raw);
  const numbers = Object.keys(parsed).map(n=>parseInt(n,10));
  if(numbers.length===0){ resBox.innerHTML = '<div class="dupBox"><b>인식된 해설이 없습니다.</b> "1. 해설내용" 형식으로 붙여넣어 주세요.</div>'; return; }

  const targets = allQuestions.filter(q=>q.source===source);
  let matched = 0;
  const unmatchedNums = [];
  for(const num of numbers){
    const q = targets.find(x=>x.examQuestionNumber===num);
    if(!q){ unmatchedNums.push(num); continue; }
    await updateDoc(doc(db, QUESTIONS_COL, q.id), { explanation: parsed[num], updatedAt: Date.now() });
    matched++;
  }
  const noNumTargets = targets.filter(q=>q.examQuestionNumber==null).length;
  let html = '<div class="okBox">✓ '+matched+'개 문항에 해설이 적용되었습니다.</div>';
  if(unmatchedNums.length){
    html += '<div class="dupBox" style="margin-top:8px;"><b>매칭 안 된 번호: '+unmatchedNums.join(', ')+'</b><br>해당 번호의 문항을 이 출처에서 찾지 못했어요. 상세보기에서 "원문항번호"가 제대로 들어가 있는지 확인해주세요.</div>';
  }
  if(noNumTargets>0){
    html += '<div style="font-size:11.5px;color:var(--muted);margin-top:8px;">참고: 이 출처의 문항 중 '+noNumTargets+'개는 원문항번호가 비어있어 매칭 대상에서 제외됐어요.</div>';
  }
  resBox.innerHTML = html;
});

// ---------- single add/edit modal ----------
const overlaySingle = document.getElementById("overlaySingle");
let editingId = null;
let pendingImages = [];
let pendingDataBlocks = [];

function resetSingleForm(){
  ["f_source","f_stem","f_passage","f_answer","f_chartTitle","f_chartData"].forEach(id=>document.getElementById(id).value="");
  [1,2,3,4,5].forEach(n=>document.getElementById("f_c"+n).value="");
  document.getElementById("f_domain").value="의사소통능력";
  document.getElementById("f_difficulty").value="미정";
  document.getElementById("f_type").value="미정";
  document.getElementById("f_subType").value="";
  document.getElementById("f_chartType").value="table";
  document.getElementById("f_dataBlockPreview").innerHTML="";
  document.getElementById("f_imageLinkInput").value="";
  document.getElementById("f_imageFileInput").value="";
  document.getElementById("f_imageFileStatus").textContent="사진을 선택하면 자동으로 크기를 줄여서 문제 데이터에 바로 저장돼요. 외부 서비스나 링크가 필요 없어요.";
  document.getElementById("f_imgPreview").innerHTML="";
  ["f_usageInst","f_usageWhen","f_usageGrade"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("f_usagePreview").innerHTML="";
  document.getElementById("checkResult").innerHTML="";
  pendingImages = [];
  pendingUsage = [];
  pendingDataBlocks = [];
}
document.getElementById("openSingle").addEventListener("click", ()=>{
  editingId=null;
  document.getElementById("singleTitle").textContent="새 문제 추가";
  resetSingleForm();
  overlaySingle.classList.add("open");
});
function openEditFor(id){
  editingId = id;
  const q = allQuestions.find(x=>x.id===id);
  document.getElementById("singleTitle").textContent = "문제 편집 · "+id;
  document.getElementById("f_domain").value = q.domain;
  document.getElementById("f_source").value = q.source||"";
  document.getElementById("f_stem").value = q.stem||"";
  document.getElementById("f_passage").value = q.passage||"";
  [1,2,3,4,5].forEach(n=>document.getElementById("f_c"+n).value=(q.choices||[])[n-1]||"");
  document.getElementById("f_answer").value = q.answer||"";
  document.getElementById("f_difficulty").value = q.difficulty||"미정";
  document.getElementById("f_type").value = q.type||"미정";
  document.getElementById("f_subType").value = q.subType||"";
  document.getElementById("f_chartType").value = "table";
  document.getElementById("f_chartTitle").value = "";
  document.getElementById("f_chartData").value = "";
  pendingDataBlocks = (q.dataBlocks||[]).slice();
  renderDataBlockPreview();
  document.getElementById("f_imageLinkInput").value="";
  document.getElementById("f_imageFileInput").value="";
  pendingImages = (q.images||[]).slice();
  renderImgPreview();
  ["f_usageInst","f_usageWhen","f_usageGrade"].forEach(id=>document.getElementById(id).value="");
  pendingUsage = (q.usageLog||[]).slice();
  renderUsagePreview();
  document.getElementById("checkResult").innerHTML="";
  overlaySingle.classList.add("open");
}
document.getElementById("cancelSingle").addEventListener("click", ()=>overlaySingle.classList.remove("open"));
document.getElementById("closeXSingle").addEventListener("click", ()=>overlaySingle.classList.remove("open"));
overlaySingle.addEventListener("click", e=>{ if(e.target===overlaySingle) overlaySingle.classList.remove("open"); });

const DATA_TYPE_LABEL = {table:"표", bar:"막대그래프", line:"꺾은선그래프", pie:"원형그래프"};
function renderDataBlockPreview(){
  document.getElementById("f_dataBlockPreview").innerHTML = pendingDataBlocks.map((b,i)=>
    '<div style="display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;">'+
    '<span style="font-weight:700;">'+ DATA_TYPE_LABEL[b.type] +'</span>'+
    '<span style="color:var(--muted);">'+ (b.title || "(제목 없음)") +'</span>'+
    '<button type="button" data-rmD="'+i+'" style="margin-left:auto;border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;">×</button>'+
    '</div>'
  ).join('');
  document.getElementById("f_dataBlockPreview").querySelectorAll("button[data-rmD]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      pendingDataBlocks.splice(parseInt(btn.getAttribute("data-rmD"),10), 1);
      renderDataBlockPreview();
    });
  });
}
document.getElementById("f_addDataBlock").addEventListener("click", ()=>{
  const type = document.getElementById("f_chartType").value;
  const title = document.getElementById("f_chartTitle").value.trim();
  const raw = document.getElementById("f_chartData").value;
  if(!raw.trim()) return;
  pendingDataBlocks.push({type, title, raw});
  document.getElementById("f_chartTitle").value = "";
  document.getElementById("f_chartData").value = "";
  renderDataBlockPreview();
});

// 이미지 항목이 "<img ...>" 완성된 HTML 코드인지, 아니면 그냥 링크(URL)인지 판별.
// HTML이면 그대로 삽입하고, 링크면 <img src="..."> 로 감싸서 삽입한다.
function isImageHtmlSnippet(s){ return typeof s === "string" && s.trim().startsWith("<"); }
function extractSrcFromImgHtml(html){
  const m = html.match(/src="([^"]*)"/);
  return m ? m[1] : "";
}
function renderImageEntry(entry){
  if(isImageHtmlSnippet(entry)) return entry; // 이미 완성된 <img> HTML → 그대로 사용
  return '<img src="'+toViewableImageUrl(entry)+'" loading="lazy">';
}

function renderImgPreview(){
  document.getElementById("f_imgPreview").innerHTML = pendingImages.map((entry,i)=>{
    const thumbSrc = isImageHtmlSnippet(entry) ? extractSrcFromImgHtml(entry) : toViewableImageUrl(entry);
    const label = isImageHtmlSnippet(entry) ? "(첨부한 사진)" : entry;
    return '<div style="display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:11px;max-width:100%;">'+
    '<img src="'+thumbSrc+'" style="width:36px;height:36px;object-fit:cover;border-radius:4px;" onerror="this.style.display=\'none\'">'+
    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;">'+label+'</span>'+
    '<button type="button" data-rm="'+i+'" style="border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;">×</button>'+
    '</div>';
  }).join('');
  document.getElementById("f_imgPreview").querySelectorAll("button[data-rm]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      pendingImages.splice(parseInt(btn.getAttribute("data-rm"),10), 1);
      renderImgPreview();
    });
  });
}
document.getElementById("f_addImageLink").addEventListener("click", ()=>{
  const input = document.getElementById("f_imageLinkInput");
  const link = input.value.trim();
  if(!link) return;
  pendingImages.push(link); // 링크로 추가한 건 순수 URL 그대로 저장 (표시할 때 <img>로 감싸짐)
  input.value = "";
  renderImgPreview();
});
function estimatePendingImagesSize(extra){
  return JSON.stringify(pendingImages.concat(extra?[extra]:[])).length;
}

document.getElementById("f_addHtmlImage").addEventListener("click", ()=>{
  const input = document.getElementById("f_htmlImageInput");
  const statusEl = document.getElementById("f_imageFileStatus");
  const code = input.value.trim();
  if(!code) return;
  if(estimatePendingImagesSize(code) > 900000){
    statusEl.textContent = "⚠ 이 코드를 추가하면 문항 데이터가 너무 커져서(1MB 제한) 저장이 안 될 수 있어요. 기존 이미지를 먼저 지워주세요.";
    return;
  }
  pendingImages.push(code); // 붙여넣은 HTML 코드를 그대로 저장 (그대로 삽입됨)
  input.value = "";
  renderImgPreview();
});

// 파일을 캔버스로 리사이즈+압축한 뒤, 완성된 <img> HTML 태그로 만들어 그 HTML 자체를 저장한다
// (별도 파일 저장소 없이 Firestore 문서 안에 "이미지가 이미 삽입된 HTML"로 들어감)
function compressImageFile(file, maxWidth=1000, quality=0.7){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        if(w > maxWidth){ h = Math.round(h * maxWidth / w); w = maxWidth; }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function buildImageHtml(dataUrl){
  return '<img src="'+dataUrl+'" style="max-width:100%;height:auto;border-radius:8px;border:1px solid #ddd;">';
}
document.getElementById("f_imageFileInput").addEventListener("change", async (e)=>{
  const files = Array.from(e.target.files);
  const statusEl = document.getElementById("f_imageFileStatus");
  for(const file of files){
    statusEl.textContent = "'"+file.name+"' 압축 중...";
    try{
      let dataUrl = await compressImageFile(file, 1000, 0.7);
      if(dataUrl.length > 700000){
        dataUrl = await compressImageFile(file, 800, 0.5); // 여전히 크면 한 번 더 압축
      }
      const candidate = buildImageHtml(dataUrl);
      if(estimatePendingImagesSize(candidate) > 900000){
        statusEl.textContent = "⚠ '"+file.name+"' 추가하면 문항 데이터가 너무 커져서(1MB 제한) 저장이 안 될 수 있어요. 기존 이미지를 먼저 지워주세요.";
        continue;
      }
      pendingImages.push(candidate); // 완성된 <img> HTML을 그대로 저장
      renderImgPreview();
      statusEl.textContent = "✓ 사진을 추가했어요 (약 "+Math.round(dataUrl.length/1024)+"KB). 여러 장 더 첨부할 수 있어요.";
    }catch(err){
      console.error(err);
      statusEl.textContent = "'"+file.name+"' 처리에 실패했어요.";
    }
  }
  e.target.value = "";
});

let pendingUsage = [];
function renderUsagePreview(){
  document.getElementById("f_usagePreview").innerHTML = pendingUsage.map((u,i)=>
    '<div style="display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;">'+
    '<span style="font-weight:700;">'+ (u.institution||"-") +'</span>'+
    '<span style="color:var(--muted);">'+ (u.when||"-") +'</span>'+
    '<span style="color:var(--muted);">'+ (u.grade||"-") +'</span>'+
    '<button type="button" data-rmU="'+i+'" style="margin-left:auto;border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;">×</button>'+
    '</div>'
  ).join('');
  document.getElementById("f_usagePreview").querySelectorAll("button[data-rmU]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      pendingUsage.splice(parseInt(btn.getAttribute("data-rmU"),10), 1);
      renderUsagePreview();
    });
  });
}
document.getElementById("f_addUsage").addEventListener("click", ()=>{
  const inst = document.getElementById("f_usageInst").value.trim();
  const when = document.getElementById("f_usageWhen").value.trim();
  const grade = document.getElementById("f_usageGrade").value.trim();
  if(!inst && !when && !grade) return;
  pendingUsage.push({institution:inst, when, grade});
  ["f_usageInst","f_usageWhen","f_usageGrade"].forEach(id=>document.getElementById(id).value="");
  renderUsagePreview();
});

function readForm(){
  return {
    domain: document.getElementById("f_domain").value,
    source: document.getElementById("f_source").value.trim(),
    stem: document.getElementById("f_stem").value.trim(),
    passage: document.getElementById("f_passage").value.trim(),
    choices: [1,2,3,4,5].map(n=>document.getElementById("f_c"+n).value.trim()).filter(v=>v),
    answer: document.getElementById("f_answer").value.trim(),
    difficulty: document.getElementById("f_difficulty").value,
    type: document.getElementById("f_type").value,
    subType: document.getElementById("f_subType").value.trim(),
    images: pendingImages.slice(),
    usageLog: pendingUsage.slice(),
    dataBlocks: pendingDataBlocks.slice()
  };
}

async function runManualReplace(forceVersion){
  const targetId = document.getElementById("f_manualReplaceId").value.trim();
  const resBox = document.getElementById("checkResult"); resBox.innerHTML="";
  if(!targetId){ resBox.innerHTML='<div class="dupBox"><b>교체할 기존 문항 ID를 입력해주세요.</b></div>'; return; }
  const existing = allQuestions.find(q=>q.id===targetId);
  if(!existing){ resBox.innerHTML='<div class="dupBox"><b>\''+targetId+'\' ID를 가진 문항을 찾을 수 없어요.</b> 정확한 ID인지 확인해주세요.</div>'; return; }
  const form = readForm();
  if(!form.stem){ resBox.innerHTML='<div class="dupBox"><b>문제(발문)를 입력해 주세요.</b></div>'; return; }
  const result = await applyReplace(targetId, form, forceVersion);
  resBox.innerHTML = result.versioned
    ? '<div class="okBox">✓ '+targetId+' 문항을 새 버전으로 교체했어요. (이전 내용은 이력에 보관됩니다)</div>'
    : '<div class="okBox">✓ '+targetId+' 문항에 동일 문제로 반영했어요. (버전은 그대로예요)</div>';
  setTimeout(()=>overlaySingle.classList.remove("open"), 800);
}
document.getElementById("f_manualReplaceSameBtn").addEventListener("click", ()=>runManualReplace(false));
document.getElementById("f_manualReplaceVersionBtn").addEventListener("click", ()=>runManualReplace(true));

document.getElementById("checkAndUpload").addEventListener("click", async ()=>{
  const form = readForm();
  const resBox = document.getElementById("checkResult"); resBox.innerHTML="";
  if(!form.stem){ resBox.innerHTML='<div class="dupBox"><b>문제(발문)를 입력해 주세요.</b></div>'; return; }

  if(editingId){
    const result = await applyReplace(editingId, form);
    resBox.innerHTML = result.versioned
      ? '<div class="okBox">✓ '+editingId+' 문항이 수정되었습니다. (새 버전으로 기록됐어요)</div>'
      : '<div class="okBox">✓ '+editingId+' 문항이 수정되었습니다. (내용은 기존과 동일해서 버전은 그대로예요)</div>';
    setTimeout(()=>overlaySingle.classList.remove("open"), 700);
    return;
  }

  let best={sim:0,q:null};
  const newText = form.stem+" "+form.passage;
  allQuestions.forEach(q=>{ const sim=combinedSimilarity(newText, form.images, q); if(sim>best.sim) best={sim,q}; });

  if(best.sim >= SIM_THRESHOLD){
    resBox.innerHTML =
      '<div class="dupBox"><b>중복 의심 (유사도 '+Math.round(best.sim*100)+'%)</b><br>'+
      '기존 문항 <b>'+best.q.id+'</b>('+best.q.domain+')와 내용이 매우 비슷합니다.<br>'+
      '<span style="color:#555;">"'+best.q.stem.slice(0,60)+(best.q.stem.length>60?'…':'')+'"</span>'+
      '<div class="dupBtns">'+
      '<button class="btn ghost small" id="replaceSameBtn">동일 문제로 저장 ('+best.q.id+', 버전 유지)</button>'+
      '<button class="btn primary small" id="replaceVersionBtn">새 버전으로 교체 ('+best.q.id+')</button>'+
      '<button class="btn ghost small" id="forceAddBtn">그래도 새 문제로 등록</button>'+
      '</div></div>';
    const doReplace = async (forceVersion) => {
      const result = await applyReplace(best.q.id, form, forceVersion);
      resBox.innerHTML = result.versioned
        ? '<div class="okBox">✓ '+best.q.id+' 문항이 새 버전으로 교체되었습니다.</div>'
        : '<div class="okBox">✓ '+best.q.id+' 문항에 동일 문제로 반영했어요. (버전 유지)</div>';
      setTimeout(()=>overlaySingle.classList.remove("open"), 800);
    };
    document.getElementById("replaceSameBtn").onclick = ()=>doReplace(false);
    document.getElementById("replaceVersionBtn").onclick = ()=>doReplace(true);
    document.getElementById("forceAddBtn").onclick = async ()=>{
      await addNew(form);
      resBox.innerHTML = '<div class="okBox">✓ 새 문제로 등록되었습니다.</div>';
      setTimeout(()=>overlaySingle.classList.remove("open"), 700);
    };
    return;
  }
  await addNew(form);
  resBox.innerHTML = '<div class="okBox">✓ 새 문제로 등록되었습니다.</div>';
  setTimeout(()=>overlaySingle.classList.remove("open"), 700);
});

// ---------- file upload: auto-extract text from PDF/DOCX ----------
if(window.pdfjsLib){
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function extractPdfText(file){
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for(let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const items = content.items
      .filter(it => it.str !== undefined)
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

    items.sort((a,b) => (b.y - a.y) || (a.x - b.x));

    const lines = [];
    let curLine = [];
    let curY = null;
    const Y_TOLERANCE = 3;
    items.forEach(it=>{
      if(curY === null || Math.abs(it.y - curY) <= Y_TOLERANCE){
        curLine.push(it);
        curY = curY===null ? it.y : curY;
      } else {
        lines.push(curLine);
        curLine = [it];
        curY = it.y;
      }
    });
    if(curLine.length) lines.push(curLine);

    const pageText = lines.map(line=>{
      line.sort((a,b)=>a.x-b.x);
      return line.map(it=>it.str).join("");
    }).join("\n");

    text += pageText + "\n";
  }
  return text;
}

async function extractDocxText(file){
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

const KNOWN_INSTITUTION_ALIASES = [
  "한신대","국민대","조선대","서울과기대","수도전기공업고등학교","수도공고","경기영상과학고"
];

function parseFileNameMeta(filename){
  const base = (filename||"").replace(/\.[^.]+$/, "").trim();
  const result = { institution:"", when:"", grade:"", source: base };

  const aliasHits = KNOWN_INSTITUTION_ALIASES.filter(name=>base.includes(name));
  if(aliasHits.length){
    result.institution = aliasHits.sort((a,b)=>b.length-a.length)[0];
  } else {
    const instMatch = base.match(/[가-힣A-Za-z0-9]+(?:초등학교|중학교|고등학교|전문대학|대학교|대학)/);
    if(instMatch) result.institution = instMatch[0];
  }

  const dateMatch = base.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if(dateMatch){
    result.when = dateMatch[1]+"년 "+dateMatch[2]+"월 "+dateMatch[3]+"일";
  } else {
    const semMatch = base.match(/(\d{4})\s*년\s*(\d)\s*학기/);
    if(semMatch) result.when = semMatch[1]+"년 "+semMatch[2]+"학기";
    else{
      const yearOnly = base.match(/(\d{4})\s*년/);
      if(yearOnly) result.when = yearOnly[1]+"년";
    }
  }

  const gradeMatch = base.match(/(\d\s*[~\-]\s*\d|\d)\s*학년/);
  if(gradeMatch) result.grade = gradeMatch[1].replace(/\s+/g,"")+"학년";

  return result;
}

function applyFileNameMetaToBatchForm(filename){
  const meta = parseFileNameMeta(filename);
  const sourceEl = document.getElementById("batch_source");
  const instEl = document.getElementById("batch_usageInst");
  const whenEl = document.getElementById("batch_usageWhen");
  const gradeEl = document.getElementById("batch_usageGrade");
  let filled = [];
  if(!sourceEl.value.trim() && meta.source){ sourceEl.value = meta.source; filled.push("출처"); }
  if(!instEl.value.trim() && meta.institution){ instEl.value = meta.institution; filled.push("기관"); }
  if(!whenEl.value.trim() && meta.when){ whenEl.value = meta.when; filled.push("시기"); }
  if(!gradeEl.value.trim() && meta.grade){ gradeEl.value = meta.grade; filled.push("학년"); }
  return filled;
}

async function handleExamFile(file){
  if(!file) return;
  const statusEl = document.getElementById("fileExtractStatus");
  const filledFields = applyFileNameMetaToBatchForm(file.name);
  statusEl.textContent = "파일에서 텍스트를 추출하는 중...";
  try{
    let text = "";
    const name = file.name.toLowerCase();
    if(name.endsWith(".pdf")){
      if(!window.pdfjsLib){ statusEl.textContent = "PDF 처리 라이브러리를 불러오지 못했어요. 새로고침 후 다시 시도해주세요."; return; }
      text = await extractPdfText(file);
    } else if(name.endsWith(".docx")){
      if(!window.mammoth){ statusEl.textContent = "DOCX 처리 라이브러리를 불러오지 못했어요. 새로고침 후 다시 시도해주세요."; return; }
      text = await extractDocxText(file);
    } else { statusEl.textContent = "PDF 또는 DOCX 파일만 지원돼요."; return; }

    document.getElementById("batchInput").value = text;
    const metaNote = filledFields.length
      ? (" (파일명에서 "+filledFields.join("·")+" 자동 채움 — 위에서 확인/수정해주세요)")
      : "";
    statusEl.textContent = "✓ 텍스트를 추출했어요. 아래 내용을 확인하고 '분석하기'를 눌러주세요 (표/이미지 있는 문제는 별도로 확인이 필요할 수 있어요)."+metaNote;
  }catch(err){
    console.error(err);
    statusEl.textContent = "추출에 실패했어요: " + (err && err.message ? err.message : "알 수 없는 오류") + " (콘솔에서 자세한 내용을 확인할 수 있어요)";
  }
}

document.getElementById("examFileInput").addEventListener("change", (e)=>{
  handleExamFile(e.target.files[0]);
});

const dropZone = document.getElementById("fileDropZone");
["dragenter","dragover"].forEach(evt=>{
  dropZone.addEventListener(evt, (e)=>{
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add("dragover");
  });
});
["dragleave","dragend"].forEach(evt=>{
  dropZone.addEventListener(evt, (e)=>{
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove("dragover");
  });
});
dropZone.addEventListener("drop", (e)=>{
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if(file) handleExamFile(file);
});

// ---------- batch modal ----------
const overlayBatch = document.getElementById("overlayBatch");
const TEMPLATE = "[영역] 의사소통능력\n[출처] \n[유형] 미정\n[세부유형] \n[문제] \n[지문] \n[보기]\n1) \n2) \n3) \n4) \n5) \n[정답] \n[난이도] 미정\n=====\n";
let batchMode = "auto";

document.getElementById("openBatch").addEventListener("click", ()=>{
  document.getElementById("batchInput").value="";
  document.getElementById("batchResult").innerHTML="";
  document.getElementById("batchConfirmRow").style.display="none";
  ["batch_usageInst","batch_usageWhen","batch_usageGrade"].forEach(id=>document.getElementById(id).value="");
  overlayBatch.classList.add("open");
});
document.getElementById("cancelBatch").addEventListener("click", ()=>overlayBatch.classList.remove("open"));
document.getElementById("closeXBatch").addEventListener("click", ()=>overlayBatch.classList.remove("open"));
overlayBatch.addEventListener("click", e=>{ if(e.target===overlayBatch) overlayBatch.classList.remove("open"); });
document.getElementById("copyTemplate").addEventListener("click", ()=>{
  navigator.clipboard.writeText(TEMPLATE).then(()=>{
    document.getElementById("copyTemplate").textContent = "복사됨 ✓";
    setTimeout(()=>{ document.getElementById("copyTemplate").textContent="템플릿 복사"; }, 1500);
  });
});

document.getElementById("modeAutoBtn").addEventListener("click", ()=>{
  batchMode = "auto";
  document.getElementById("modeAutoBtn").classList.add("active");
  document.getElementById("modeTemplateBtn").classList.remove("active");
  document.getElementById("autoModeBar").style.display = "grid";
  document.getElementById("copyTemplate").style.display = "none";
  document.getElementById("batchModeDesc").textContent = "기존 모의고사 파일(한글/워드)에서 문제를 그대로 복사해서 붙여넣으면 자동으로 인식합니다.";
  document.getElementById("batchInput").placeholder = "여기에 시험지 내용을 그대로 붙여넣으세요.";
});
document.getElementById("modeTemplateBtn").addEventListener("click", ()=>{
  batchMode = "template";
  document.getElementById("modeTemplateBtn").classList.add("active");
  document.getElementById("modeAutoBtn").classList.remove("active");
  document.getElementById("autoModeBar").style.display = "none";
  document.getElementById("copyTemplate").style.display = "inline-block";
  document.getElementById("batchModeDesc").innerHTML = "아래 템플릿을 복사해 여러 문제를 채운 뒤, 문제 사이를 <b>=====</b> 줄로 구분해서 통째로 붙여넣으세요.";
  document.getElementById("batchInput").placeholder = "여기에 붙여넣기...";
});

function parseBlock(text){
  const tagRe = /\[(영역|출처|유형|세부유형|문제|지문|보기|정답|난이도)\]/;
  const lines = text.split("\n");
  let cur = null; const data = {영역:"",출처:"",유형:"",세부유형:"",문제:"",지문:"",보기:"",정답:"",난이도:""};
  lines.forEach(line=>{
    const m = line.match(tagRe);
    if(m && line.trim().startsWith("[")){
      cur = m[1];
      const rest = line.replace(tagRe,"").trim();
      if(rest) data[cur] += (data[cur]?"\n":"") + rest;
    } else if(cur){
      data[cur] += (data[cur]?"\n":"") + line;
    }
  });
  Object.keys(data).forEach(k=>data[k]=data[k].trim());
  const choiceLines = data["보기"].split("\n").map(l=>l.trim()).filter(l=>l);
  const choices = choiceLines.map(l=>l.replace(/^[0-9]\)\s*/,"").replace(/^[①②③④⑤]\s*/,"").trim()).filter(v=>v);
  return {
    domain: data["영역"] || "의사소통능력",
    source: data["출처"], stem: data["문제"], passage: data["지문"],
    choices, answer: data["정답"], difficulty: data["난이도"] || "미정",
    type: data["유형"] || "미정", subType: data["세부유형"] || ""
  };
}

const NOISE_PATTERNS = [
  /^직업기초능력평가$/, /NCS\s*실전모의고사/, /^혼합형/, /^학교맞춤/, /^Copyright/i,
  /^\(계속\s*\)$/, /^\(\s*\)$/, /^-\s*끝\s*-$/, /^문제의 답을 다시/, /^문항\s*수/, /^시험시간/, /^\d+\/\d+$/,
  /^:\s*\d+$/, /^&?PSAT$/i, /^이\s*름\s*점\s*수$/
];
const DOMAIN_NAMES = Object.keys(DOMAIN_CODE);
function detectDomainHeader(line){
  for(const name of DOMAIN_NAMES){
    if(line.includes(name) && /\d+\s*[~\-]\s*\d+\s*번/.test(line)) return name;
    if(line.trim() === name) return name;
  }
  return null;
}
function isNoise(line){ return NOISE_PATTERNS.some(re=>re.test(line.trim())); }

const CIRCLED_MARKS = ["①","②","③","④","⑤"];
const CIRCLED_SPLIT_RE = /([①②③④⑤])/;

const IMAGE_KEYWORDS = ["그림", "사진", "도표", "배치도", "구성도", "회로도", "도면", "이미지"];
function detectNeedsImage(stem, passage){
  const combined = (stem||"") + " " + (passage||"");
  if(IMAGE_KEYWORDS.some(kw=>combined.includes(kw))) return true;
  const captionMatch = (passage||"").match(/<[^<>]{2,40}>/g);
  if(captionMatch){
    const lastCaption = captionMatch[captionMatch.length-1];
    const afterCaption = passage.slice(passage.lastIndexOf(lastCaption) + lastCaption.length).trim();
    if(afterCaption.length < 40) return true;
  }
  return false;
}

function guessDomain(text, fallback){
  const t = text || "";
  const scores = {
    "의사소통능력": 0, "수리능력": 0, "문제해결능력": 0, "자원관리능력": 0, "기술능력": 0,
    "자기개발능력": 0, "대인관계능력": 0, "정보능력": 0, "조직이해능력": 0, "직업윤리": 0
  };

  [/다음\s*글을\s*읽고/, /일치하지\s*않는/, /일치하는\s*것은/, /제목으로\s*적절/, /경청/, /화법/,
   /빈칸에\s*들어갈\s*단어/, /맞춤법/, /어법/, /문서작성/, /비즈니스\s*레터/, /공지사항/, /안내문/,
   /논리적\s*오류/, /제목의/].forEach(re=>{ if(re.test(t)) scores["의사소통능력"] += 2; });

  [/다음\s*빈칸에\s*들어갈\s*수/, /확률/, /평균/, /방정식/, /증가율/, /감소율/,
   /소금물/, /농도/, /경우의\s*수/, /단위\s*:/, /표를\s*보고/, /자료에\s*대한/].forEach(re=>{ if(re.test(t)) scores["수리능력"] += 2; });
  const qtyMatches = (t.match(/\d+\s*(%|원|명|시간|분|초|㎝|cm|㎏|kg|km|개|점|g|ℓ|㎖|ml|배|㎧)/g)||[]).length;
  if(qtyMatches >= 4) scores["수리능력"] += 3;
  else if(qtyMatches >= 2) scores["수리능력"] += 2;

  [/<\s*조건/, /다음\s*조건/, /명제/, /창의적\s*사고/, /비판적\s*사고/, /논리적\s*사고/, /브레인스토밍/,
   /SWOT/i, /3C\s*분석/, /순위를\s*매기/, /추론할\s*수\s*있는/, /유추할\s*수\s*있는/, /가설\s*설정/,
   /이슈\s*분석/, /원인을\s*분석/, /항상\s*참인/, /반드시\s*옳지/, /조건에\s*따라/,
   /문제해결/, /문제처리/].forEach(re=>{ if(re.test(t)) scores["문제해결능력"] += 2; });

  [/예산/, /인력\s*배치/, /시간관리/, /물적자원/, /최소\s*비용/, /최단\s*시간/, /작업\s*지시서/,
   /인력을\s*배치/].forEach(re=>{ if(re.test(t)) scores["자원관리능력"] += 2; });

  [/매뉴얼/, /기술\s*적용/, /장비/, /설비/, /작동법/, /고장/, /점검/].forEach(re=>{ if(re.test(t)) scores["기술능력"] += 2; });

  [/자기개발/, /경력개발/, /목표\s*설정/, /자아인식/].forEach(re=>{ if(re.test(t)) scores["자기개발능력"] += 2; });

  [/갈등관리/, /리더십/, /협상/, /고객\s*서비스/, /팀워크/, /동기부여/].forEach(re=>{ if(re.test(t)) scores["대인관계능력"] += 2; });

  [/엑셀/, /데이터베이스/, /정보\s*수집/, /컴퓨터활용/, /스프레드시트/, /함수식/].forEach(re=>{ if(re.test(t)) scores["정보능력"] += 2; });

  [/조직도/, /경영전략/, /결재/, /조직구조/, /전결/, /품의서/].forEach(re=>{ if(re.test(t)) scores["조직이해능력"] += 2; });

  [/직업윤리/, /준법/, /근면/, /봉사/, /책임의식/, /정직/].forEach(re=>{ if(re.test(t)) scores["직업윤리"] += 2; });

  let best = null, bestScore = 0;
  Object.keys(scores).forEach(d=>{
    if(scores[d] > bestScore){ bestScore = scores[d]; best = d; }
  });
  return best || fallback;
}

function trySplitChoices(line, startIdx){
  const marks = CIRCLED_MARKS;
  if(!line.startsWith(marks[startIdx])) return null;
  const parts = line.split(CIRCLED_SPLIT_RE).filter(s=>s!=="");
  let idx = startIdx;
  const texts = [];
  let i = 0;
  while(i < parts.length){
    if(parts[i] === marks[idx]){
      texts.push((parts[i+1]!==undefined ? parts[i+1] : "").trim());
      idx++;
      i += 2;
    } else break;
  }
  return {newIdx: idx, texts};
}

function parseExamText(rawText, fallbackDomain, source, fallbackType, fallbackSubType){
  rawText = rawText.replace(/➀/g,"①").replace(/➁/g,"②").replace(/➂/g,"③").replace(/➃/g,"④").replace(/➄/g,"⑤");
  const lines = rawText.split("\n").map(l=>l.replace(/\r$/,"").trim()).filter(l=>l);
  let currentDomain = fallbackDomain;
  let anyDomainHeaderSeen = false;
  const items = [];

  let pending = [];
  let choices = [];
  let expectingIdx = 0;
  let choicesComplete = false;
  let lastQNum = null;

  let sharedPassage = "";
  let sharedGroupStart = null;
  let sharedGroupEnd = null;
  let collectingSharedPassage = false;

  function numberOf(lineList){
    for(const l of lineList){
      const m = l.match(/^(\d{1,3})[.\)]\s*\S/);
      if(m) return parseInt(m[1],10);
    }
    return null;
  }

  function finalizeQuestion(){
    const bufText = pending.join("\n").trim();
    if(bufText || choices.length){
      const foundNum = numberOf(pending);
      if(foundNum!==null) lastQNum = foundNum;
      let stem = bufText, passage = "";
      const qIdx = bufText.indexOf("?");
      if(qIdx >= 0){
        stem = bufText.slice(0, qIdx+1).trim();
        passage = bufText.slice(qIdx+1).trim();
      }
      stem = stem.replace(/^\d{1,3}[.\)]\s*/, "").trim();
      if(sharedGroupEnd!==null && sharedPassage){
        passage = sharedPassage + (passage ? ("\n"+passage) : "");
      }
      const domain = anyDomainHeaderSeen ? currentDomain : guessDomain(stem+" "+passage, fallbackDomain);
      items.push({
        domain, source: source || "", stem, passage,
        choices: choices.map(c=>c.trim()).filter(Boolean),
        answer: "", difficulty: "미정",
        type: fallbackType || "미정", subType: fallbackSubType || "",
        needsImage: detectNeedsImage(stem, passage),
        examQuestionNumber: foundNum,
        _domainGuessed: !anyDomainHeaderSeen
      });
      if(sharedGroupEnd!==null && foundNum!==null && foundNum>=sharedGroupEnd){
        sharedGroupEnd = null; sharedGroupStart = null; sharedPassage = "";
      }
    }
    pending = [];
    choices = [];
    expectingIdx = 0;
    choicesComplete = false;
  }

  lines.forEach(trimmed=>{
    if(isNoise(trimmed)){
      if(choicesComplete) finalizeQuestion();
      return;
    }
    const domHeader = detectDomainHeader(trimmed);
    if(domHeader){
      if(choicesComplete) finalizeQuestion();
      currentDomain = domHeader;
      anyDomainHeaderSeen = true;
      return;
    }

    const groupMatch = trimmed.match(/^\[\s*(\d{1,3})\s*[~\-]\s*(\d{1,3})\s*\]\s*(.*)$/);
    if(groupMatch){
      if(choicesComplete) finalizeQuestion();
      pending = []; choices = []; expectingIdx = 0; choicesComplete = false;
      sharedGroupStart = parseInt(groupMatch[1],10);
      sharedGroupEnd = parseInt(groupMatch[2],10);
      collectingSharedPassage = true;
      sharedPassage = groupMatch[3] ? groupMatch[3].trim() : "";
      return;
    }

    if(collectingSharedPassage){
      const startNumMatch = trimmed.match(/^(\d{1,3})[.\)]\s*\S/);
      if(startNumMatch && parseInt(startNumMatch[1],10) === sharedGroupStart){
        collectingSharedPassage = false;
      } else {
        sharedPassage += (sharedPassage?"\n":"") + trimmed;
        return;
      }
    }

    if(items.length===0 && choices.length===0){
      const firstQMatch = trimmed.match(/^1[.\)]\s*\S/);
      if(firstQMatch && numberOf(pending)===null){
        pending = [];
      }
    }

    if(trimmed.startsWith(CIRCLED_MARKS[0]) && (choicesComplete || expectingIdx>0)){
      choices = [];
      expectingIdx = 0;
      choicesComplete = false;
    }

    if(choicesComplete){
      const m = trimmed.match(/^(\d{1,3})[.\)]\s*\S/);
      if(m){
        const n = parseInt(m[1],10);
        const curNum = numberOf(pending);
        const expected = (curNum!==null ? curNum : lastQNum);
        if(expected!==null && n===expected+1){
          finalizeQuestion();
          pending.push(trimmed);
          return;
        }
      }
    }

    const splitResult = !choicesComplete ? trySplitChoices(trimmed, expectingIdx) : null;
    if(splitResult && splitResult.texts.length>0){
      splitResult.texts.forEach(t=>choices.push(t));
      expectingIdx = splitResult.newIdx;
      if(expectingIdx === CIRCLED_MARKS.length) choicesComplete = true;
      return;
    }
    if(choices.length>0 && (choicesComplete || (expectingIdx>0 && expectingIdx<CIRCLED_MARKS.length))){
      choices[choices.length-1] += " " + trimmed;
      return;
    }
    pending.push(trimmed);
  });
  if(pending.length || choices.length) finalizeQuestion();
  return items.filter(it=>it.stem);
}

let batchParsed = [];
document.getElementById("parseBatch").addEventListener("click", ()=>{
  const raw = document.getElementById("batchInput").value;

  if(batchMode === "auto"){
    const fallbackDomain = document.getElementById("batch_domain").value;
    const source = document.getElementById("batch_source").value.trim();
    const fallbackType = document.getElementById("batch_type").value;
    const fallbackSubType = document.getElementById("batch_subType").value.trim();
    batchParsed = parseExamText(raw, fallbackDomain, source, fallbackType, fallbackSubType);
  } else {
    const blocks = raw.split(/^=+$/m).map(b=>b.trim()).filter(b=>b);
    batchParsed = blocks.map(parseBlock).filter(item=>item.stem);
  }

  const resBox = document.getElementById("batchResult");
  if(batchParsed.length===0){
    resBox.innerHTML = '<div class="dupBox"><b>인식된 문제가 없습니다.</b> 템플릿 형식을 확인해주세요.</div>';
    document.getElementById("batchConfirmRow").style.display="none";
    return;
  }

  const anyGuessed = batchParsed.some(item=>item._domainGuessed);
  const guessNote = anyGuessed
    ? '<div style="font-size:11.5px;color:var(--ring);background:var(--ok-bg);border-radius:8px;padding:8px 12px;margin-bottom:10px;">🔍 표시된 영역은 이 시험지에 영역 구분 표시가 없어서 문제 내용을 보고 추측한 값이에요. 틀린 항목은 아래에서 바로 고쳐주세요.</div>'
    : '';

  resBox.innerHTML = guessNote + batchParsed.map((item,i)=>{
    const newText = item.stem+" "+item.passage;
    let best={sim:0,q:null};
    allQuestions.forEach(q=>{ const sim=combinedSimilarity(newText, item.images, q); if(sim>best.sim) best={sim,q}; });
    for(let j=0;j<i;j++){
      const other = batchParsed[j];
      const sim = combinedSimilarity(newText, item.images, {stem:other.stem, passage:other.passage, images:other.images});
      if(sim>best.sim) best={sim, q:{id:"(배치 내 "+(j+1)+"번)", domain:other.domain, stem:other.stem}};
    }
    item._dup = best.sim >= SIM_THRESHOLD;
    item._matchId = best.q ? best.q.id : null;
    item._matchIsExisting = !!(best.q && !String(best.q.id).startsWith("(배치 내"));
    item._sim = best.sim;
    const cls = item._dup ? "dup" : "ok";
    const statusText = item._dup ? ("중복 의심 "+Math.round(best.sim*100)+"% · "+best.q.id) : "등록 가능";
    const imgWarnBadge = item.needsImage
      ? '<span style="display:inline-block;background:var(--warn-bg);color:var(--warn);font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px;">🖼 이미지 첨부 필요</span>'
      : "";
    const DOMAIN_OPTIONS = Object.keys(DOMAIN_CODE);
    const TYPE_OPTIONS = ["미정","모듈","피듈","피셋","직무"];
    return '<div class="batchItem '+cls+'" data-idx="'+i+'">'+
      '<div class="title">'+(i+1)+'. '+item.stem.slice(0,50)+imgWarnBadge+'</div>'+
      '<div class="status">'+statusText+'</div>'+
      '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'+
        '<span style="font-size:11px;color:var(--muted);flex-shrink:0;">영역'+(item._domainGuessed?' 🔍':'')+'</span>'+
        '<select data-domainidx="'+i+'" style="font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;">'+
          DOMAIN_OPTIONS.map(d=>'<option'+(d===item.domain?' selected':'')+'>'+d+'</option>').join('')+
        '</select>'+
        '<span style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:4px;">유형</span>'+
        '<select data-typeidx="'+i+'" style="font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;">'+
          TYPE_OPTIONS.map(t=>'<option'+(t===(item.type||"미정")?' selected':'')+'>'+t+'</option>').join('')+
        '</select>'+
        '<span style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:4px;">세부유형</span>'+
        '<input type="text" data-subtypeidx="'+i+'" value="'+(item.subType||"").replace(/"/g,'&quot;')+'" placeholder="예: 응용수리" style="flex:1;min-width:110px;font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;">'+
        '<span style="font-size:11px;color:var(--muted);flex-shrink:0;margin-left:4px;">원문항번호</span>'+
        '<input type="number" data-qnumidx="'+i+'" value="'+(item.examQuestionNumber!=null?item.examQuestionNumber:"")+'" placeholder="예: 1" style="width:64px;font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;">'+
      '</div>'+
      '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;">'+
        '<span style="font-size:11px;color:'+(item.needsImage?'var(--warn)':'var(--muted)')+';flex-shrink:0;font-weight:'+(item.needsImage?'700':'400')+';">🖼 이미지 링크'+(item.needsImage?'(필요)':'(선택)')+'</span>'+
        '<input type="text" data-imgidx="'+i+'" placeholder="https://drive.google.com/file/d/..." style="flex:1;font-size:11.5px;padding:5px 8px;border:1px solid '+(item.needsImage?'var(--warn)':'var(--line)')+';border-radius:6px;">'+
      '</div>'+
      (item._dup ? '<div class="batchBtns">'+
        (item._matchIsExisting
          ? '<button class="btn small primary" data-batchact="addusage" data-idx="'+i+'">＋ '+item._matchId+'에 사용이력만 추가</button>'
          : '<span style="font-size:11px;color:var(--muted);align-self:center;">배치 내 다른 문항과 중복이라 이력 추가는 개별 확인이 필요해요</span>'
        )+
        '<button class="btn small ghost" data-batchact="force" data-idx="'+i+'">그래도 등록</button><button class="btn small ghost" data-batchact="skip" data-idx="'+i+'">건너뛰기 처리됨</button></div>' : "") +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);">'+
        '<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">기존 문항 개정판인가요?</div>'+
        '<input type="text" data-manualidx="'+i+'" list="existingQIdList" placeholder="ID 지정 (예: COM-0005)" style="width:100%;font-size:11px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;margin-bottom:6px;">'+
        '<div style="display:flex;gap:6px;">'+
          '<button type="button" class="btn small ghost" data-manualsamebtn="'+i+'" style="flex:1;font-size:11px;">동일 문제로 저장</button>'+
          '<button type="button" class="btn small primary" data-manualversionbtn="'+i+'" style="flex:1;font-size:11px;">새 버전으로 교체</button>'+
        '</div>'+
      '</div>'+
      '</div>';
  }).join("");

  resBox.querySelectorAll("select[data-domainidx]").forEach(sel=>{
    sel.addEventListener("change", ()=>{
      const idx = parseInt(sel.getAttribute("data-domainidx"),10);
      batchParsed[idx].domain = sel.value;
    });
  });
  resBox.querySelectorAll("select[data-typeidx]").forEach(sel=>{
    sel.addEventListener("change", ()=>{
      const idx = parseInt(sel.getAttribute("data-typeidx"),10);
      batchParsed[idx].type = sel.value;
    });
  });
  resBox.querySelectorAll("input[data-subtypeidx]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const idx = parseInt(inp.getAttribute("data-subtypeidx"),10);
      batchParsed[idx].subType = inp.value.trim();
    });
  });
  resBox.querySelectorAll("input[data-qnumidx]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const idx = parseInt(inp.getAttribute("data-qnumidx"),10);
      const v = inp.value.trim();
      batchParsed[idx].examQuestionNumber = v ? parseInt(v,10) : null;
    });
  });

  resBox.querySelectorAll("input[data-imgidx]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const idx = parseInt(inp.getAttribute("data-imgidx"),10);
      batchParsed[idx].images = inp.value.trim() ? [inp.value.trim()] : [];
    });
  });

  async function runBatchManualReplace(idx, btn, forceVersion){
    const input = resBox.querySelector('input[data-manualidx="'+idx+'"]');
    const targetId = input.value.trim();
    if(!targetId){ alert("교체할 기존 문항 ID를 입력해주세요."); return; }
    const existing = allQuestions.find(q=>q.id===targetId);
    if(!existing){ alert("'"+targetId+"' ID를 가진 문항을 찾을 수 없어요. 목록에서 정확한 ID를 확인해주세요."); return; }
    if(!confirm(targetId+(forceVersion ? " 문항을 새 버전으로 교체할까요?" : " 문항에 동일 문제로 반영할까요? (버전 유지)"))) return;
    const item = batchParsed[idx];
    const container = btn.closest("div");
    container.querySelectorAll("button").forEach(b=>b.disabled=true);
    const result = await applyReplace(targetId, {
      domain: item.domain, source: item.source, stem: item.stem, passage: item.passage,
      choices: item.choices, answer: item.answer, difficulty: item.difficulty,
      type: item.type||"미정", subType: item.subType||"", images: item.images||[]
    }, forceVersion);
    batchParsed[idx]._skip = true; // 새로 등록하지 않고 교체로 처리됨
    btn.closest(".batchItem").style.opacity = "0.6";
    container.innerHTML = result.versioned
      ? '<span style="font-size:11px;color:var(--ok);font-weight:700;">✓ '+targetId+' 문항을 새 버전으로 교체했어요</span>'
      : '<span style="font-size:11px;color:var(--ok);font-weight:700;">✓ '+targetId+'에 동일 문제로 반영했어요 (버전 유지)</span>';
  }
  resBox.querySelectorAll("button[data-manualsamebtn]").forEach(btn=>{
    btn.addEventListener("click", ()=>runBatchManualReplace(parseInt(btn.getAttribute("data-manualsamebtn"),10), btn, false));
  });
  resBox.querySelectorAll("button[data-manualversionbtn]").forEach(btn=>{
    btn.addEventListener("click", ()=>runBatchManualReplace(parseInt(btn.getAttribute("data-manualversionbtn"),10), btn, true));
  });

  resBox.querySelectorAll("button[data-batchact]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const idx = parseInt(btn.getAttribute("data-idx"),10);
      const act = btn.getAttribute("data-batchact");
      if(act==="force") batchParsed[idx]._forceAdd = true;
      if(act==="skip") batchParsed[idx]._skip = true;
      if(act==="addusage"){
        const uInst = document.getElementById("batch_usageInst").value.trim();
        const uWhen = document.getElementById("batch_usageWhen").value.trim();
        const uGrade = document.getElementById("batch_usageGrade").value.trim();
        if(!uInst && !uWhen && !uGrade){
          alert("추가할 사용 이력(기관/시기/학년)을 위쪽 '사용 이력' 칸에 먼저 입력해주세요.");
          return;
        }
        btn.disabled = true; btn.textContent = "추가 중...";
        const ok = await addUsageToExisting(batchParsed[idx]._matchId, {institution:uInst, when:uWhen, grade:uGrade});
        if(ok){
          batchParsed[idx]._usageAdded = true;
          batchParsed[idx]._skip = true;
          btn.closest(".batchItem").style.opacity = "0.6";
          btn.parentElement.innerHTML = '<span style="font-size:11px;color:var(--ok);font-weight:700;">✓ '+batchParsed[idx]._matchId+'에 사용이력이 추가되었습니다</span>';
        } else {
          btn.disabled = false; btn.textContent = "＋ "+batchParsed[idx]._matchId+"에 사용이력만 추가";
          alert("추가에 실패했어요. 다시 시도해주세요.");
        }
        return;
      }
      btn.closest(".batchItem").style.opacity = "0.5";
      btn.parentElement.innerHTML = '<span style="font-size:11px;color:var(--muted);">처리 완료</span>';
    });
  });

  document.getElementById("batchConfirmRow").style.display = "flex";
});

document.getElementById("registerAllOk").addEventListener("click", async ()=>{
  const uInst = document.getElementById("batch_usageInst").value.trim();
  const uWhen = document.getElementById("batch_usageWhen").value.trim();
  const uGrade = document.getElementById("batch_usageGrade").value.trim();
  const commonUsageLog = (uInst||uWhen||uGrade) ? [{institution:uInst, when:uWhen, grade:uGrade}] : [];
  let count = 0;
  for(const item of batchParsed){
    if(item._skip) continue;
    if(item._dup && !item._forceAdd) continue;
    const hasImage = (item.images||[]).length > 0;
    await addNew({domain:item.domain, source:item.source, stem:item.stem, passage:item.passage, choices:item.choices, answer:item.answer, difficulty:item.difficulty, type:item.type||"미정", subType:item.subType||"", images:item.images||[], usageLog: commonUsageLog, needsImage: item.needsImage && !hasImage, examQuestionNumber: (item.examQuestionNumber!==undefined ? item.examQuestionNumber : null)});
    count++;
  }
  document.getElementById("batchResult").innerHTML += '<div class="okBox">✓ 총 '+count+'개 문항이 등록되었습니다.</div>';
  document.getElementById("batchConfirmRow").style.display="none";
});
