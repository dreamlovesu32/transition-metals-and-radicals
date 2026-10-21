"use strict";
window.ReadWorkbenchRead = Object.freeze({
 asset(path,id){return `/figures/${encodeURIComponent(path.split("/").pop())}?article=${encodeURIComponent(id)}`;},
 async catalog(){const r=await fetch("/api/catalog",{cache:"no-store"});if(!r.ok)throw new Error("文章目录暂时无法载入");return r.json();},
 async read(id){const r=await fetch(`/api/document?lang=zh&view=reader${id ? "&article="+encodeURIComponent(id) : ""}`,{cache:"no-store"});if(!r.ok)throw new Error("文章暂时无法载入");return r.json();}
});
