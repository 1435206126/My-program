document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input');
  const statusDiv = document.getElementById('status');
  const insertBtn = document.getElementById('insert-btn');

  let selectedFiles = [];

  // --- 1. 选择文件 ---
  fileInput.addEventListener('change', (e) => {
    selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length === 0) return;
    
    // 按文件名数字排序
    selectedFiles.sort((a, b) => {
      const numA = parseInt(a.name.match(/^\d+/)?.[0] || 0);
      const numB = parseInt(b.name.match(/^\d+/)?.[0] || 0);
      return numA - numB;
    });

    statusDiv.textContent = `✅ 已准备 ${selectedFiles.length} 个文件`;
    insertBtn.style.display = 'block';
  });

  // --- 2. 点击开始 ---
  insertBtn.addEventListener('click', async () => {
    insertBtn.disabled = true;
    insertBtn.style.backgroundColor = '#ccc';
    
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    const tabId = tabs[0].id;

    try {
      statusDiv.textContent = '🔐 正在获取公众号授权信息...';
      const pageInfo = await getPageAuthInfo(tabId);
      
      // 如果是纯处理TXT可能不需要token，但为了统一逻辑还是检查一下
      if (!pageInfo || !pageInfo.token) {
        console.warn('未获取到Token，如果是纯文本操作可能不影响');
      }

      // 逐个处理
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const isTxt = file.name.toLowerCase().endsWith('.txt');
        
        statusDiv.textContent = `⚡ [${i + 1}/${selectedFiles.length}] 处理中: ${file.name}...`;

        try {
          let cdnUrl = '';
          let txtContent = '';

          // --- 分支逻辑 ---
          if (isTxt) {
            // A. 如果是 TXT：读取文字，不上传
            txtContent = await readFileAsText(file);
          } else {
            // B. 如果是 图片：上传到微信
            statusDiv.textContent = `☁️ [${i + 1}/${selectedFiles.length}] 上传图片: ${file.name}...`;
            if (!pageInfo || !pageInfo.token) throw new Error('上传图片需要登录公众号后台');
            cdnUrl = await uploadToWeChat(file, pageInfo);
          }

          // --- 生成完整HTML ---
          const fullHtml = generateFullHtml(file, txtContent, cdnUrl);

          statusDiv.textContent = `📝 [${i + 1}/${selectedFiles.length}] 排版插入...`;

          // --- 插入编辑器 ---
          await runScript(tabId, directDomInsert, [fullHtml]);

          // 稍微延时，给编辑器渲染喘息时间
          await new Promise(r => setTimeout(r, 500));

        } catch (err) {
          console.error(err);
          statusDiv.textContent = `⚠️ 第 ${i+1} 个文件出错: ${err.message}`;
          await new Promise(r => setTimeout(r, 2000)); 
        }
      }

      statusDiv.textContent = '🎉 全部完成！';
      statusDiv.style.color = 'green';

    } catch (e) {
      statusDiv.textContent = `❌ 错误: ${e.message}`;
      statusDiv.style.color = 'red';
    } finally {
      insertBtn.disabled = false;
      insertBtn.style.backgroundColor = '#07c160';
    }
  });

  // ============================================
  // 工具函数
  // ============================================

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file, 'UTF-8'); // 默认UTF-8，如果乱码可改为 'GB2312'
    });
  }

  async function getPageAuthInfo(tabId) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');
        let ticket = '';
        try {
             if (window.wx && window.wx.commonData && window.wx.commonData.data) {
                 ticket = window.wx.commonData.data.ticket || window.wx.commonData.data.ticket_id;
             }
        } catch (e) {}
        return { token, ticket };
      }
    });
    return result[0].result;
  }

  async function uploadToWeChat(file, { token, ticket }) {
    const formData = new FormData();
    formData.append('id', 'WU_FILE_0'); 
    formData.append('name', file.name);
    formData.append('type', file.type);
    formData.append('lastModifiedDate', new Date());
    formData.append('size', file.size);
    formData.append('file', file);

    let uploadUrl = `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&writetype=doublewrite&groupid=1&token=${token}&lang=zh_CN`;
    if (ticket) uploadUrl += `&ticket_id=${ticket}`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
      referrerPolicy: 'no-referrer'
    });

    const json = await response.json();
    if (json.cdn_url) return json.cdn_url;
    if (json.base_resp && json.base_resp.ret !== 0) throw new Error(json.base_resp.err_msg);
    throw new Error('未知响应结构');
  }

  async function runScript(tabId, func, args) {
      return chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: func,
          args: args
      });
  }

  // 生成完整的HTML内容，确保正确的排序
  function generateFullHtml(file, txtContent, imgUrl) {
    const match = file.name.match(/^(\d+)(.*)\./);
    let serialNum = match ? match[1] : '0';
    let descText = match ? match[2] : file.name;

    let fullHtml = '';
    
    // 1. 只有序号为1时显示【每日杂图】
    if (serialNum == '1') {
      fullHtml += `<p style="font-size: 20px; font-weight: bold; text-align: center;">【每日杂图】</p><p><br/></p>`;
    }

    // 2. 序号
    fullHtml += `<p style="font-size: 20px; font-weight: bold; text-align: center;">${serialNum}</p>`;

    // 3. 标题 (文件名)
    fullHtml += `<p style="font-size: 20px; font-weight: bold; text-align: center;">${descText}</p>`;

    // 4. 内容部分：TXT文件内容 或 图片
    if (txtContent) {
        // 如果是TXT文件：插入文件内容
        const contentHtml = txtContent.split('\n').map(line => {
            return `<p style="font-size: 16px; text-align: justify;">${line || '<br/>'}</p>`;
        }).join('');
        fullHtml += contentHtml;
    } else if (imgUrl) {
        // 如果是图片文件：插入图片
        fullHtml += `<img src="${imgUrl}" data-src="${imgUrl}" data-type="${file.type === 'image/gif' ? 'gif' : 'jpeg'}" style="max-width: 100%; display: block; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">`;
    }

    // 5. 结尾空行
    fullHtml += `<p><br/></p><p><br/></p>`;
    
    return fullHtml;
  }
});

// ==========================================
// 注入页面函数：DOM 操作
// ==========================================

function directDomInsert(fullHtml) {
    const iframe = document.getElementById('ueditor_0');
    let targetDoc = document;
    let targetWin = window;

    if (iframe) {
        try {
            targetDoc = iframe.contentDocument || iframe.contentWindow.document;
            targetWin = iframe.contentWindow;
        } catch(e) {}
    }

    targetWin.focus();
    targetDoc.body.focus();

    // 一次性插入完整的HTML内容，确保排序正确
    targetDoc.execCommand('insertHTML', false, fullHtml);

    // 滚动到底部
    setTimeout(() => {
        try {
             targetWin.scrollTo(0, targetDoc.body.scrollHeight);
        } catch(e) {}
    }, 50);
}