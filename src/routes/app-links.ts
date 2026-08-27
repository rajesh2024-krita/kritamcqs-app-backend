import { Router, type IRouter } from "express";

const router: IRouter = Router();
const ANDROID_PACKAGE = "app.kritamcqs.androidapp";
const IOS_APP_ID = process.env["IOS_APP_LINK_ID"] || "8J365CZNSS.app.kritamcqs.iosapp";

router.get("/.well-known/assetlinks.json", (_req, res) => {
  const fingerprints = String(process.env["ANDROID_APP_LINK_SHA256"] || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(fingerprints.length ? 200 : 503).json(fingerprints.length ? [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }] : { error: "ANDROID_APP_LINK_SHA256 is not configured" });
});

router.get("/.well-known/apple-app-site-association", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({ applinks: { apps: [], details: [{ appID: IOS_APP_ID, paths: ["/affiliate", "/affiliate/*"] }] } });
});

router.get(["/affiliate", "/affiliate/"], (req, res) => {
  const code = String(req.query["ref"] || "").trim().toUpperCase();
  const safeCode = /^[A-Z0-9_-]{4,24}$/.test(code) ? code : "";
  const apiPath = "/api/affiliate/track";
  const playStore = "https://play.google.com/store/apps/details?id=app.kritamcqs.androidapp";
  const appStore = process.env["IOS_APP_STORE_URL"] || "https://apps.apple.com/app/krita-mcqs";
  // Values are serialized rather than interpolated as markup, preventing HTML/script injection.
  const config = JSON.stringify({ code: safeCode, apiPath, playStore, appStore }).replace(/</g, "\\u003c");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Opening Krita MCQs</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#eef2ff,#fff,#ecfeff);font-family:Inter,system-ui;color:#172033}.card{width:min(440px,92vw);padding:36px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 20px 60px #64748b22}.logo{margin:auto;display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:#4f46e5;color:#fff;font-size:24px;font-weight:900}.spinner{width:30px;height:30px;margin:24px auto;border:3px solid #c7d2fe;border-top-color:#4f46e5;border-radius:50%;animation:s .8s linear infinite}.error{color:#b91c1c}.retry{display:none;margin:18px auto 0;border:0;border-radius:10px;padding:11px 16px;background:#4f46e5;color:#fff;font-weight:800}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><main class="card"><div class="logo">K</div><h1>Opening Krita MCQs</h1><p id="message">Saving your referral and opening the Krita MCQs app…</p><div class="spinner" id="spinner"></div><button class="retry" id="retry">Continue</button></main><script>const CONFIG=${config};const message=document.getElementById("message"),retry=document.getElementById("retry");function destination(clickId){if(/iPad|iPhone|iPod/i.test(navigator.userAgent))return CONFIG.appStore;const referrer=new URLSearchParams({affiliate_code:CONFIG.code});if(clickId)referrer.set("referral_click_id",clickId);return CONFIG.playStore+"&referrer="+encodeURIComponent(referrer.toString())}function go(url){retry.onclick=()=>location.href=url;retry.style.display="block";location.replace(url)}if(!CONFIG.code){message.className="error";message.textContent="This affiliate link is invalid.";document.getElementById("spinner").style.display="none"}else fetch(CONFIG.apiPath,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({affiliateCode:CONFIG.code,referralUrl:location.href,platform:/Android/i.test(navigator.userAgent)?"ANDROID":/iPad|iPhone|iPod/i.test(navigator.userAgent)?"IOS":"WEB",deviceType:navigator.userAgent,browser:navigator.userAgent})}).then(r=>{if(!r.ok)throw new Error("Referral is inactive or unavailable");return r.json()}).then(data=>go(destination(data.referralClickId))).catch(error=>{message.textContent=error.message+". Continuing to the app store…";go(destination("") )});</script></body></html>`);
});

export default router;
