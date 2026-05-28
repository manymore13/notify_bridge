import axios from "axios";

const APP_ID = process.env.FEISHU_APP_ID || "YOUR_APP_ID";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "YOUR_APP_SECRET";

async function main() {
  console.log("=== 查找飞书 Open ID ===\n");

  // Get token
  const tokenRes = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  const token = tokenRes.data.tenant_access_token;
  console.log("Token: OK\n");

  // Method 1: Try contact v3 users with different URL
  console.log("[1] GET /contact/v3/users ...");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/contact/v3/users",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 5 },
      }
    );
    console.log(`  code=${r.data.code} msg=${r.data.msg}`);
    if (r.data.code === 0 && r.data.data?.items?.length > 0) {
      for (const u of r.data.data.items) {
        console.log(`  -> ${u.name} | open_id=${u.open_id} | email=${u.email || "-"}`);
      }
    }
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 120)}`);
  }

  // Method 2: Get bot's own info (always works)
  console.log("\n[2] GET /authen/v1/user_info (当前登录用户)...");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`  code=${r.data.code} msg=${r.data.msg || "ok"}`);
    if (r.data.code === 0) {
      console.log(`  -> name=${r.data.data?.name}`);
      console.log(`  -> open_id=${r.data.data?.open_id}`);
      console.log(`  -> user_id=${r.data.data?.user_id}`);
      console.log(`  -> email=${r.data.data?.email || "-"}`);
    }
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 120)}`);
  }

  // Method 3: Try scope endpoint
  console.log("\n[3] GET /contact/v3/scopes ...");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/contact/v3/scopes",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`  code=${r.data.code} msg=${r.data.msg || "ok"}`);
    console.log(JSON.stringify(r.data.data, null, 2).slice(0, 300));
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 120)}`);
  }

  // Method 4: Try department list
  console.log("\n[4] GET /contact/v3/departments ...");
  try {
    const r = await axios.get(
      "https://open.feishu.cn/open-apis/contact/v3/departments",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 5 },
      }
    );
    console.log(`  code=${r.data.code} msg=${r.data.msg || "ok"}`);
    if (r.data.code === 0) {
      const depts = r.data.data?.items || [];
      console.log(`  找到 ${depts.length} 个部门`);
      for (const d of depts.slice(0, 3)) {
        console.log(`  -> ${d.name} (id=${d.department_id})`);
        // Try to list users in this department
        if (d.department_id) {
          try {
            const ur = await axios.get(
              `https://open.feishu.cn/open-apis/contact/v3/users/find_by_department`,
              {
                headers: { Authorization: `Bearer ${token}` },
                params: { department_id: d.department_id, page_size: 3 },
              }
            );
            if (ur.data.code === 0) {
              const users = ur.data.data?.items || [];
              for (const u of users) {
                console.log(`    -> ${u.name} | open_id=${u.open_id} | email=${u.email || "-"}`);
              }
            }
          } catch {}
        }
      }
    }
  } catch (e: any) {
    console.log(`  HTTP ${e.response?.status}: ${e.response?.data?.msg?.slice(0, 120)}`);
  }

  console.log("\n=== 完成 ===");
  console.log("如果以上方法都无法获取 open_id，请手动提供:");
  console.log("  你的飞书邮箱 (如 user@example.com) 或 手机号");
}

main().catch(e => console.error("ERROR:", e.message));
