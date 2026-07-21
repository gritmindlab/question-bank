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

// 구글 드라이브 공유 링크 -> <img>에서 바로 보이는 형태로 변환
// (드라이브 파일이 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있어야 정상적으로 보임)
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

async function addNew(form){
  const id = nextIdFor(form.domain);
  const docData = {
    id, domain: form.domain, stem: form.stem, passage: form.passage,
    choices: form.choices, source: form.source || "그릿마인드랩 자체 제작",
    images: form.images||[], usageLog: form.usageLog||[],
    answer: form.answer, difficulty: form.difficulty,
    version: 1, history: [], deleted: false,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await setDoc(doc(db, QUESTIONS_COL, id), docData);
  return id;
}

async function applyReplace(id, form){
  const prevSnap = await getDoc(doc(db, QUESTIONS_COL, id));
  const prev = prevSnap.data();
  const history = prev.history || [];
  history.push({
    stem:prev.stem, passage:prev.passage, choices:prev.choices, answer:prev.answer,
    difficulty:prev.difficulty, images:prev.images, replacedAt: Date.now()
  });
  await updateDoc(doc(db, QUESTIONS_COL, id), {
    stem: form.stem, passage: form.passage, choices: form.choices,
    source: form.source || prev.source, images: form.images||[],
    usageLog: form.usageLog||[],
    answer: form.answer, difficulty: form.difficulty,
    version: (prev.version||1)+1, history, updatedAt: Date.now()
  });
}

async function deleteQuestion(id){
  await updateDoc(doc(db, QUESTIONS_COL, id), { deleted: true, updatedAt: Date.now() });
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
  const curDomain = document.getElementById("domainFilter").value; // "" = 전체
  let html = '<button type="button" class="statchip'+(curDomain===""?" active":"")+'" data-statdom="">전체 <b>'+allQuestions.length+'</b>문항</button>';
  Object.keys(byDomain).forEach(dom=>{
    html += '<button type="button" class="statchip'+(curDomain===dom?" active":"")+'" data-statdom="'+dom+'">'+dom+' <b>'+byDomain[dom]+'</b></button>';
  });
  document.getElementById("statrow").innerHTML = html;
  document.getElementById("totalCount").textContent = allQuestions.length;

  const domSel = document.getElementById("domainFilter");
  const cur = domSel.value;
  domSel.innerHTML = '<option value="">영역 전체</option>' + Object.keys(DOMAIN_CODE).map(d=>'<option>'+d+'</option>').join('');
  domSel.value = cur;

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
        renderStats(); // refresh active-state highlighting without full table rebuild
      } else {
        renderTable();
      }
    });
  });
}

function getFiltered(){
  const q = document.getElementById("searchBox").value.trim().toLowerCase();
  const dom = document.getElementById("domainFilter").value;
  const diff = document.getElementById("diffFilter").value;
  let list = allQuestions.slice();
  if(dom) list = list.filter(x=>x.domain===dom);
  if(diff) list = list.filter(x=>(x.difficulty||"미정")===diff);
  if(q) list = list.filter(x => (x.id+" "+x.stem+" "+(x.passage||"")+" "+(x.source||"")).toLowerCase().includes(q));
  return list;
}

function renderTable(){
  renderStats();
  const list = getFiltered();
  // drop selections that are no longer in the filtered/visible set from stale ids (keep across filter changes, just prune deleted)
  const allIds = new Set(allQuestions.map(q=>q.id));
  selectedIds.forEach(id=>{ if(!allIds.has(id)) selectedIds.delete(id); });

  const tbody = document.getElementById("tbody");
  if(list.length===0){
    tbody.innerHTML = '<tr><td colspan="9"><div class="emptyrow">조건에 맞는 문제가 없습니다.</div></td></tr>';
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
      '<td class="stemcell" title="'+ (q.stem||"").replace(/"/g,'&quot;') +'">'+stemShort+'</td>'+
      '<td>'+ (q.difficulty||"미정") +'</td>'+
      '<td class="idcell">'+ (q.answer||"-") +'</td>'+
      '<td style="font-size:11.5px;color:var(--muted);">'+ (q.source||"-") +'</td>'+
      '<td style="font-size:11.5px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+usageShort.replace(/"/g,'&quot;')+'">'+usageShort+'</td>'+
      '<td class="imgbadge">'+ (imgCount>0 ? ('🖼 '+imgCount) : '-') +'</td>'+
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

["searchBox","domainFilter","diffFilter"].forEach(id=>{
  document.getElementById(id).addEventListener("input", renderTable);
  document.getElementById(id).addEventListener("change", renderTable);
});

// ---------- view toggle ----------
document.getElementById("viewListBtn").addEventListener("click", ()=>{
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

function renderDetail(){
  const q = currentList[detailIdx];
  if(!q) return;
  document.getElementById("qnumLabel").textContent = "문항 "+(detailIdx+1)+" / "+currentList.length;
  document.getElementById("detailPos").textContent = (detailIdx+1)+"/"+currentList.length;
  const col = DOMAIN_COLORS[q.domain]||{c:"var(--primary-2)",bg:"#eee"};
  const chip = document.getElementById("domainChip");
  chip.textContent=q.domain; chip.style.color=col.c; chip.style.background=col.bg;
  document.getElementById("qid").textContent=q.id;
  document.getElementById("qsource").textContent=q.source||"-";
  const usageBox = document.getElementById("qUsageList");
  const usage = q.usageLog||[];
  usageBox.innerHTML = usage.length
    ? usage.map(u=>'<div>'+ [u.institution, u.when, u.grade].filter(Boolean).join(' · ') +'</div>').join('')
    : '-';
  document.getElementById("stemText").textContent=q.stem;
  document.getElementById("imgsBox").innerHTML = (q.images||[]).map(src=>'<img src="'+toViewableImageUrl(src)+'" loading="lazy">').join('');
  const passageBox = document.getElementById("passageBox");
  if(q.passage && q.passage.trim()){ passageBox.style.display="block"; passageBox.textContent=q.passage; }
  else passageBox.style.display="none";
  const list = document.getElementById("choicesList"); list.innerHTML="";
  const marks=['①','②','③','④','⑤'];
  (q.choices||[]).forEach((c,i)=>{ const li=document.createElement("li"); li.innerHTML='<span class="cnum">'+marks[i]+'</span><span>'+c+'</span>'; list.appendChild(li); });
  document.getElementById("diffSelect").value = q.difficulty||"미정";
  document.getElementById("answerInput").value = q.answer||"";
  document.getElementById("versionTag").textContent = q.version&&q.version>1 ? ("v"+q.version+" · 이전 버전 "+(q.history?q.history.length:0)+"건 보관") : "";
  document.getElementById("prevBtn").disabled = detailIdx===0;
  document.getElementById("nextBtn").disabled = detailIdx===currentList.length-1;
}
document.getElementById("prevBtn").addEventListener("click", ()=>{ if(detailIdx>0){ detailIdx--; renderDetail(); } });
document.getElementById("nextBtn").addEventListener("click", ()=>{ if(detailIdx<currentList.length-1){ detailIdx++; renderDetail(); } });
document.getElementById("diffSelect").addEventListener("change", async(e)=>{
  const id=currentList[detailIdx].id;
  await updateDoc(doc(db, QUESTIONS_COL, id), { difficulty: e.target.value, updatedAt: Date.now() });
});
document.getElementById("answerInput").addEventListener("change", async(e)=>{
  const id=currentList[detailIdx].id;
  await updateDoc(doc(db, QUESTIONS_COL, id), { answer: e.target.value, updatedAt: Date.now() });
});

// ---------- bulk edit modal ----------
const overlayBulk = document.getElementById("overlayBulk");
document.getElementById("bulkEditBtn").addEventListener("click", ()=>{
  document.getElementById("bulkModalCount").textContent = selectedIds.size;
  document.getElementById("bulk_domain").value = "";
  document.getElementById("bulk_difficulty").value = "";
  document.getElementById("bulk_source").value = "";
  ["bulk_usageInst","bulk_usageWhen","bulk_usageGrade"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("bulkResult").innerHTML = "";
  overlayBulk.classList.add("open");
});
document.getElementById("cancelBulk").addEventListener("click", ()=>overlayBulk.classList.remove("open"));
overlayBulk.addEventListener("click", e=>{ if(e.target===overlayBulk) overlayBulk.classList.remove("open"); });

document.getElementById("applyBulk").addEventListener("click", async ()=>{
  const domain = document.getElementById("bulk_domain").value;
  const difficulty = document.getElementById("bulk_difficulty").value;
  const source = document.getElementById("bulk_source").value.trim();
  const uInst = document.getElementById("bulk_usageInst").value.trim();
  const uWhen = document.getElementById("bulk_usageWhen").value.trim();
  const uGrade = document.getElementById("bulk_usageGrade").value.trim();
  const addUsage = uInst || uWhen || uGrade;

  if(!domain && !difficulty && !source && !addUsage){
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

// ---------- single add/edit modal ----------
const overlaySingle = document.getElementById("overlaySingle");
let editingId = null;
let pendingImages = [];

function resetSingleForm(){
  ["f_source","f_stem","f_passage","f_answer"].forEach(id=>document.getElementById(id).value="");
  [1,2,3,4,5].forEach(n=>document.getElementById("f_c"+n).value="");
  document.getElementById("f_domain").value="의사소통능력";
  document.getElementById("f_difficulty").value="미정";
  document.getElementById("f_imageLinkInput").value="";
  document.getElementById("f_imgPreview").innerHTML="";
  ["f_usageInst","f_usageWhen","f_usageGrade"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("f_usagePreview").innerHTML="";
  document.getElementById("checkResult").innerHTML="";
  pendingImages = [];
  pendingUsage = [];
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
  document.getElementById("f_imageLinkInput").value="";
  pendingImages = (q.images||[]).slice();
  renderImgPreview();
  ["f_usageInst","f_usageWhen","f_usageGrade"].forEach(id=>document.getElementById(id).value="");
  pendingUsage = (q.usageLog||[]).slice();
  renderUsagePreview();
  document.getElementById("checkResult").innerHTML="";
  overlaySingle.classList.add("open");
}
document.getElementById("cancelSingle").addEventListener("click", ()=>overlaySingle.classList.remove("open"));
overlaySingle.addEventListener("click", e=>{ if(e.target===overlaySingle) overlaySingle.classList.remove("open"); });

function renderImgPreview(){
  document.getElementById("f_imgPreview").innerHTML = pendingImages.map((link,i)=>
    '<div style="display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:11px;max-width:100%;">'+
    '<img src="'+toViewableImageUrl(link)+'" style="width:36px;height:36px;object-fit:cover;border-radius:4px;" onerror="this.style.display=\'none\'">'+
    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;">'+link+'</span>'+
    '<button type="button" data-rm="'+i+'" style="border:none;background:none;cursor:pointer;color:var(--danger);font-weight:700;">×</button>'+
    '</div>'
  ).join('');
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
  pendingImages.push(link);
  input.value = "";
  renderImgPreview();
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
    images: pendingImages.slice(),
    usageLog: pendingUsage.slice()
  };
}

document.getElementById("checkAndUpload").addEventListener("click", async ()=>{
  const form = readForm();
  const resBox = document.getElementById("checkResult"); resBox.innerHTML="";
  if(!form.stem){ resBox.innerHTML='<div class="dupBox"><b>문제(발문)를 입력해 주세요.</b></div>'; return; }

  if(editingId){
    await applyReplace(editingId, form);
    resBox.innerHTML = '<div class="okBox">✓ '+editingId+' 문항이 수정되었습니다.</div>';
    setTimeout(()=>overlaySingle.classList.remove("open"), 700);
    return;
  }

  let best={sim:0,q:null};
  const newText = form.stem+" "+form.passage;
  allQuestions.forEach(q=>{ const sim=diceSim(newText, combinedText(q)); if(sim>best.sim) best={sim,q}; });

  if(best.sim >= SIM_THRESHOLD){
    resBox.innerHTML =
      '<div class="dupBox"><b>중복 의심 (유사도 '+Math.round(best.sim*100)+'%)</b><br>'+
      '기존 문항 <b>'+best.q.id+'</b>('+best.q.domain+')와 내용이 매우 비슷합니다.<br>'+
      '<span style="color:#555;">"'+best.q.stem.slice(0,60)+(best.q.stem.length>60?'…':'')+'"</span>'+
      '<div class="dupBtns">'+
      '<button class="btn primary small" id="replaceBtn">고도화 버전으로 교체 ('+best.q.id+')</button>'+
      '<button class="btn ghost small" id="forceAddBtn">그래도 새 문제로 등록</button>'+
      '</div></div>';
    document.getElementById("replaceBtn").onclick = async ()=>{
      await applyReplace(best.q.id, form);
      resBox.innerHTML = '<div class="okBox">✓ '+best.q.id+' 문항이 고도화 버전으로 교체되었습니다.</div>';
      setTimeout(()=>overlaySingle.classList.remove("open"), 800);
    };
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
    const pageText = content.items.map(it=>it.str).join(" ");
    text += pageText + "\n";
  }
  return text;
}

async function extractDocxText(file){
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

document.getElementById("examFileInput").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const statusEl = document.getElementById("fileExtractStatus");
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
    statusEl.textContent = "✓ 텍스트를 추출했어요. 아래 내용을 확인하고 '분석하기'를 눌러주세요 (표/이미지 있는 문제는 별도로 확인이 필요할 수 있어요).";
  }catch(err){
    console.error(err);
    statusEl.textContent = "추출에 실패했어요: " + (err && err.message ? err.message : "알 수 없는 오류") + " (콘솔에서 자세한 내용을 확인할 수 있어요)";
  }
});

// ---------- batch modal ----------
const overlayBatch = document.getElementById("overlayBatch");
const TEMPLATE = "[영역] 의사소통능력\n[출처] \n[문제] \n[지문] \n[보기]\n1) \n2) \n3) \n4) \n5) \n[정답] \n[난이도] 미정\n=====\n";
let batchMode = "auto"; // "auto" | "template"

document.getElementById("openBatch").addEventListener("click", ()=>{
  document.getElementById("batchInput").value="";
  document.getElementById("batchResult").innerHTML="";
  document.getElementById("batchConfirmRow").style.display="none";
  overlayBatch.classList.add("open");
});
document.getElementById("cancelBatch").addEventListener("click", ()=>overlayBatch.classList.remove("open"));
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
  const tagRe = /\[(영역|출처|문제|지문|보기|정답|난이도)\]/;
  const lines = text.split("\n");
  let cur = null; const data = {영역:"",출처:"",문제:"",지문:"",보기:"",정답:"",난이도:""};
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
    choices, answer: data["정답"], difficulty: data["난이도"] || "미정"
  };
}

// 시험지 형식 자동인식: "1. 문제..." 로 시작, "① ② ③ ④ ⑤"로 보기 구분,
// "의사소통능력 1~10번" 같은 영역 제목을 만나면 이후 문항의 영역을 자동 전환
const NOISE_PATTERNS = [
  /^직업기초능력평가$/, /^NCS\s*실전모의고사/, /^혼합형/, /^학교맞춤/, /^Copyright/i,
  /^\(계속\)$/, /^-끝-$/, /^문제의 답을 다시/, /^문항\s*수/, /^시험시간/, /^\d+\/\d+$/
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

function parseExamText(rawText, fallbackDomain, source){
  const lines = rawText.split("\n");
  let currentDomain = fallbackDomain;
  const items = [];
  let cur = null;          // {domain, num, buffer:[], choices:[]}
  let expectedNext = null; // only a numbered line matching this exact count starts a new question
                           // (prevents numbered lists inside a passage, e.g. law clauses "1. ... 2. ...",
                           //  from being mistaken for new questions). null = no question seen yet,
                           // so the very first numbered line found is always accepted as question 1.

  function flush(){
    if(!cur) return;
    const bufText = cur.buffer.join("\n").trim();
    if(!bufText && cur.choices.length===0) { cur=null; return; }
    let stem = bufText, passage = "";
    const qIdx = bufText.indexOf("?");
    if(qIdx >= 0){
      stem = bufText.slice(0, qIdx+1).trim();
      passage = bufText.slice(qIdx+1).trim();
    }
    items.push({
      domain: cur.domain, source: source || "", stem, passage,
      choices: cur.choices.map(c=>c.trim()).filter(Boolean),
      answer: "", difficulty: "미정"
    });
    expectedNext = cur.num + 1;
    cur = null;
  }

  lines.forEach(rawLine=>{
    const line = rawLine.replace(/\r$/,"");
    const trimmed = line.trim();
    if(!trimmed) return;
    if(isNoise(trimmed)) return;

    const domHeader = detectDomainHeader(trimmed);
    if(domHeader){ currentDomain = domHeader; return; }

    const qMatch = trimmed.match(/^(\d{1,3})[.\)]\s*(.*)/);
    const circledMatch = trimmed.match(/^([①②③④⑤])\s*(.*)/);

    const qNum = qMatch ? parseInt(qMatch[1],10) : null;
    if(qMatch && (expectedNext===null || qNum===expectedNext)){
      flush();
      cur = { domain: currentDomain, num: qNum, buffer: [qMatch[2]], choices: [] };
      return;
    }
    if(circledMatch && cur){
      cur.choices.push(circledMatch[2]);
      return;
    }
    if(cur){
      if(cur.choices.length>0){
        cur.choices[cur.choices.length-1] += " " + trimmed;
      } else {
        cur.buffer.push(trimmed);
      }
    }
  });
  flush();
  return items.filter(it=>it.stem);
}

let batchParsed = [];
document.getElementById("parseBatch").addEventListener("click", ()=>{
  const raw = document.getElementById("batchInput").value;

  if(batchMode === "auto"){
    const fallbackDomain = document.getElementById("batch_domain").value;
    const source = document.getElementById("batch_source").value.trim();
    batchParsed = parseExamText(raw, fallbackDomain, source);
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

  resBox.innerHTML = batchParsed.map((item,i)=>{
    const newText = item.stem+" "+item.passage;
    let best={sim:0,q:null};
    allQuestions.forEach(q=>{ const sim=diceSim(newText, combinedText(q)); if(sim>best.sim) best={sim,q}; });
    for(let j=0;j<i;j++){
      const other = batchParsed[j];
      const sim = diceSim(newText, other.stem+" "+other.passage);
      if(sim>best.sim) best={sim, q:{id:"(배치 내 "+(j+1)+"번)", domain:other.domain, stem:other.stem}};
    }
    item._dup = best.sim >= SIM_THRESHOLD;
    item._matchId = best.q ? best.q.id : null;
    item._sim = best.sim;
    const cls = item._dup ? "dup" : "ok";
    const statusText = item._dup ? ("중복 의심 "+Math.round(best.sim*100)+"% · "+best.q.id) : "등록 가능";
    return '<div class="batchItem '+cls+'" data-idx="'+i+'">'+
      '<div class="title">'+(i+1)+'. ['+item.domain+'] '+item.stem.slice(0,50)+'</div>'+
      '<div class="status">'+statusText+'</div>'+
      '<div style="margin-top:8px;display:flex;gap:6px;align-items:center;">'+
        '<span style="font-size:11px;color:var(--muted);flex-shrink:0;">🖼 이미지 링크(선택)</span>'+
        '<input type="text" data-imgidx="'+i+'" placeholder="https://drive.google.com/file/d/..." style="flex:1;font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;">'+
      '</div>'+
      (item._dup ? '<div class="batchBtns"><button class="btn small ghost" data-batchact="force" data-idx="'+i+'">그래도 등록</button><button class="btn small primary" data-batchact="skip" data-idx="'+i+'">건너뛰기 처리됨</button></div>' : "") +
      '</div>';
  }).join("");

  resBox.querySelectorAll("input[data-imgidx]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const idx = parseInt(inp.getAttribute("data-imgidx"),10);
      batchParsed[idx].images = inp.value.trim() ? [inp.value.trim()] : [];
    });
  });

  resBox.querySelectorAll("button[data-batchact]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = parseInt(btn.getAttribute("data-idx"),10);
      if(btn.getAttribute("data-batchact")==="force") batchParsed[idx]._forceAdd = true;
      if(btn.getAttribute("data-batchact")==="skip") batchParsed[idx]._skip = true;
      btn.closest(".batchItem").style.opacity = "0.5";
      btn.parentElement.innerHTML = '<span style="font-size:11px;color:var(--muted);">처리 완료</span>';
    });
  });

  document.getElementById("batchConfirmRow").style.display = "flex";
});

document.getElementById("registerAllOk").addEventListener("click", async ()=>{
  let count = 0;
  for(const item of batchParsed){
    if(item._skip) continue;
    if(item._dup && !item._forceAdd) continue;
    await addNew({domain:item.domain, source:item.source, stem:item.stem, passage:item.passage, choices:item.choices, answer:item.answer, difficulty:item.difficulty, images:item.images||[]});
    count++;
  }
  document.getElementById("batchResult").innerHTML += '<div class="okBox">✓ 총 '+count+'개 문항이 등록되었습니다.</div>';
  document.getElementById("batchConfirmRow").style.display="none";
});
