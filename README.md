# ZUMEN 手機版

[ZUMEN](https://zume-n.com) 圖面管理的手機介面：**快速搜尋圖面、檢視圖面與檔案、在現場直接錄影上傳、觀看加工影片**。

電腦版請見 [jie522/260704-zumen](https://github.com/jie522/260704-zumen)，本專案沿用它的 ZUMEN API 實測結論。

## 運作方式

```
手機瀏覽器 ──Wi-Fi──▶ 公司電腦（node server.js，port 3457）──▶ zume-n.com
```

ZUMEN 沒有公開 API，必須由一台電腦用瀏覽器自動登入後代為存取，所以：

- 一台電腦開著伺服器，手機連**同一個 Wi-Fi** 就能用，手機不用裝 App
- 影片／圖檔直接從 ZUMEN 的雲端串流到手機，不經過電腦
- 上傳時手機先把檔案傳給電腦，電腦再自動上傳到 ZUMEN（大影片需要幾分鐘，期間可以繼續瀏覽）

## 功能

| 功能 | 說明 |
|---|---|
| 快速搜尋 | 打圖號、品名任一段即時搜尋，關鍵字反白；往下滑自動載入更多 |
| 檔案搜尋 | 切到「檔案」可搜尋所有分類的檔名（例如日期 261021），點了直接預覽，再一鍵前往所屬圖面 |
| 最近看過 | 首頁保留最近 12 張看過的圖面，一鍵回去 |
| 圖面檢視 | 大圖預覽、生產線別／群組等欄位、各分類檔案數量 |
| 影片總覽 | 自動彙整這張圖面所有分類裡的影片，橫向滑動挑選，點了直接播放 |
| 錄影上傳 | 「錄影」直接開相機、「拍照」、「相簿/檔案」可多選；可先取檔名、選分類。影片會先在電腦壓成 720p MP4 再上傳（省空間、Android 也能播） |
| 背景續傳 | 上傳中可繼續瀏覽；分段上傳（網路快時自動加大每段），切到別的 App、鎖螢幕、斷網都會從斷點自動接著傳，App 被關掉下次打開也會繼續；回應收不到時自動改查進度 |
| 檔案預覽 | 圖片可兩指縮放；Excel 直接顯示成表格；PDF 等先顯示第一頁預覽，再用手機內建程式開完整檔 |
| Excel 新增一筆 | 生產履歷等「Excel 表格」右下角「新增一筆」：日期預設今天、記住上次的人員；存回 ZUMEN 時保留原本格式，新檔核對無誤才刪舊檔 |
| 加入主畫面 | 支援「加入主畫面」，像 App 一樣全螢幕開啟 |

## 安裝（第一次）

```bash
git clone https://github.com/jie522/zumen.git
cd zumen
npm install
copy .env.example .env      # 打開 .env 填入 ZUMEN_EMAIL / ZUMEN_PASSWORD
node server.js
```

- 電腦需要裝 Microsoft Edge 或 Chrome（Windows 內建 Edge 即可）
- **小技巧**：如果這台電腦已在用電腦版，把電腦版資料夾裡的 `.auth-session.json` 複製過來，第一次啟動就不必再登入
- 之後可以直接雙擊 `start-zumen-mobile.vbs` 背景啟動

## 手機怎麼連

1. 電腦開 `http://localhost:3457/connect.html`，畫面會出現 QR Code
2. 手機（同一個 Wi-Fi）用相機掃描開啟
3. 瀏覽器選單 →「加入主畫面」，之後從主畫面圖示開

連不上時：確認手機跟電腦在同一個網路；Windows 防火牆第一次跳出詢問時要按「允許」（或手動開放 TCP 3457）。

## 在外面也能用（Tailscale）

ZUMEN 只接受從 zume-n.com 自己網站發出的呼叫，所以手機版一定要透過公司這台電腦轉接。
用 [Tailscale](https://tailscale.com) 在電腦和手機之間建一條私人通道，手機用 4G/5G 或在家也能連回來；
不會產生公開網址，外人連不到，也**不需要改公司防火牆**。免費版可連 100 台裝置。

**電腦（只要做一次）**
1. 到 https://tailscale.com/download/windows 下載安裝（需要系統管理員權限）
2. 右下角 Tailscale 圖示 → Log in，用 Google 或 Microsoft 帳號登入
3. 重新啟動手機版伺服器，開 `http://localhost:3457/connect.html` →「外出（Tailscale）」分頁會出現 `http://100.x.x.x:3457` 的 QR Code

**每支手機**
1. App Store / Google Play 安裝「Tailscale」
2. 登入**跟電腦同一個帳號**（同事要用時，在 Tailscale 管理頁 Users → Invite 邀請他們）
3. 打開 Tailscale 確認已連線，掃描「外出」分頁的 QR Code，再「加入主畫面」

注意：公司電腦要一直開著、不能睡眠（Windows 設定 → 電源 → 睡眠改「永不」）。
安裝 Tailscale 前建議先知會公司 IT。

## 設定（.env）

| 變數 | 說明 |
|---|---|
| `ZUMEN_EMAIL` / `ZUMEN_PASSWORD` | ZUMEN 帳密（只在登入過期時用到） |
| `ACCESS_PIN` | 手機進入時要輸入的通行碼；留空代表同 Wi-Fi 的人都能直接用 |
| `PORT` | 預設 3457（電腦版用 3456，兩個可以同時開） |

## 注意

- `.env`、`.auth-session.json` 含帳號資訊，已在 `.gitignore` 排除，**不要提交到 GitHub**（這個 repo 是公開的）
- 上傳是自動操作 ZUMEN 網頁完成的，ZUMEN 改版時上傳可能失效，修法參考電腦版 `docs/ZUMEN-API.md`
- 短時間內不要反覆重啟伺服器：每次帳密登入失敗都會累積，太多次會被 ZUMEN（Auth0）鎖帳號
- iPhone 錄的影片（HEVC .mov）在部分 Android 手機無法直接播放，畫面會提供下載連結
