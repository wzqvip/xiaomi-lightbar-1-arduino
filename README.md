# xiaomi-lightbar

用一块 **RF-Nano**（板载 nRF24L01+ 的 Arduino Nano）控制 **小米显示器挂灯 MJGJD01YL**。

这是 [benallen-dev/xiaomi-lightbar-1-arduino](https://github.com/benallen-dev/xiaomi-lightbar)
的 fork。原来的版本只是「把原作者自己遥控器抓到的 5 个报文硬编码回放」，换一台灯就
不可能工作。这里改成了按照 [lamperez 的逆向工程](https://github.com/lamperez/xiaomi-lightbar-nrf24)
**在单片机上实时构造合法报文**（含 CRC16），所以可以控制任意一台 MJGJD01YL。

本仓库的固件已在真实硬件上验证通过：开/关、色温、亮度均可用。

---

## 支持的型号（很重要）

| 型号 | 无线方式 | 本方案能否控制 |
| --- | --- | --- |
| **MJGJD01YL** | TLSR8368，2.4G 私有协议 + 旋钮遥控器 | ✅ 可以 |
| MJGJD02YL | ESP32 + 蓝牙（米家 App） | ❌ 不行，需要走蓝牙 |

型号印在灯条本体上。**如果不是 MJGJD01YL，这个项目就不适用。**

---

## 硬件

- **RF-Nano V1.0 / V2.0**（emakefun）：Nano 尺寸、板载 nRF24L01+、CH340G 串口。
- 灯条：小米显示器挂灯 MJGJD01YL。

### ⚠️ 踩坑一：RF-Nano 的 CE / CSN 引脚和普通 nRF24 接线不一样

emakefun 官方 README 里写得很清楚，但很容易看漏：

| 版本 | CE | CSN | 说明 |
| --- | --- | --- | --- |
| **RF-Nano V1.0 / V2.0** | **D10** | **D9** | 「不兼容 RF24 库的 (10, 9, 11, 12, 13)」 |
| RF-Nano V3.0 | D7 | D8 | 「兼容 RF24 库的 (7, 8, 11, 12, 13)」 |

**V1/V2 的 CE 和 CSN 是反的。** 原 fork 里硬编码的是 `CE=9, CSN=10`，在这块板子上
永远不可能工作。本固件启动时会**自动探测** (10,9) / (9,10) / (7,8) 三种接法，
所以不用手动改，串口会打印实际找到的是哪一种。

### ⚠️ 踩坑二：烧录波特率

这块板子用的是新版（optiboot）bootloader，**上传要用 115200**。
用 57600 会得到 `avrdude: stk500_getsync(): not in sync: resp=0x8e`。
`platformio.ini` 里已经设好了。

---

## 协议摘要

空口上是一个 17 字节的包：

| 字段 | 长度 | 值 |
| --- | --- | --- |
| preamble | 8 | `53 39 14 DD 1C 49 34 12`（固定） |
| remote id | 3 | 遥控器 ID，配对时写入灯条 |
| separator | 1 | `FF`（固定） |
| counter | 1 | 每发一条递增；**重复的 counter 会被灯条丢弃** |
| command | 2 | 见下表 |
| crc16 | 2 | poly `0x1021`, init `0xFFFE`, 不反转, xorout `0` |

命令码：

| 功能 | 命令码 |
| --- | --- |
| 开/关 | `0x0100` |
| 变冷（偏蓝） | `0x0200 + step`（step 1..15） |
| 变暖（偏黄） | `0x0300 - step` |
| 调亮 | `0x0400 + step` |
| 调暗 | `0x0500 - step` |
| 复位（中等亮度 + 暖色） | `0x0600` |

nRF24 发送时是 `preamble + address + payload`。把 5 字节 address 填成 `55 55 55 55 55`
（即 `0b0101...`）就相当于**延长了 Telink 的同步头**，后面 17 字节 payload 就是上面
那个包。射频参数：**channel 6 (2406 MHz)、2 Mbps、CRC 关闭、auto-ack 关闭、
payload 17 字节**。灯条在 6 / 15 / 43 / 68 四个信道之间跳频，所以本固件默认
**四个信道都发一遍**以提高成功率。

CRC16 已用逆向工程给出的 4 组实测报文验证过：

```
533914DD1C49341201B960FF790100 -> 0x3870  ✓
533914DD1C49341201B960FF160100 -> 0x8f2a  ✓
533914DD1C49341201B960FF1A0100 -> 0xfa4b  ✓
533914DD1C49341201B960FF200100 -> 0xf82f  ✓
```

---

## 配对：没有遥控器怎么办

灯条的 ID 出厂时是和一个遥控器绑定的。**没有遥控器也可以**：灯条在上电后
**20 秒内**如果收到一个合法的 `reset` 报文，就会把这个报文的 ID 记下来，
并**闪一下**表示配对成功。

所以流程是：

1. 把 RF-Nano 贴到灯条旁边（越近越好）。
2. 让 Arduino 持续广播 `reset`。
3. 在此期间把灯条**断电再上电**。
4. 灯条闪一下 → 配对成功。

`tools/lightbar.py pair` 就是干这个的，`--seconds 0` 表示一直发到你手动停，
这样就不存在「手慢了错过 20 秒窗口」的问题：

```sh
python tools/lightbar.py --id 01B960 pair --seconds 0 --pa max
```

配对用的是任意 ID（这里是 `01B960`），**原来的遥控器从此就失效了**。
想换回去，用遥控器再配对一次即可。

---

## 使用

需要 `pyserial`：`python -m pip install pyserial`

固件本身是个串口命令行，`tools/lightbar.py` 只是把它包了一层。

```sh
python tools/lightbar.py monitor              # 看串口输出
python tools/lightbar.py send info            # 打印射频寄存器配置
python tools/lightbar.py scan --seconds 30    # 抓遥控器，打印它的 ID
python tools/lightbar.py --id 01B960 on       # 开/关（切换）
python tools/lightbar.py --id 01B960 up       # 调亮
python tools/lightbar.py --id 01B960 down     # 调暗
python tools/lightbar.py --id 01B960 cool     # 变冷
python tools/lightbar.py --id 01B960 warm     # 变暖
python tools/lightbar.py --id 01B960 reset    # 复位：中等亮度 + 暖色
python tools/lightbar.py --id 01B960 brightness 8
python tools/lightbar.py --id 01B960 temp 15
python tools/lightbar.py --id 01B960 raw 0405 # 直接发原始命令码
```

> 注意：**每次打开串口都会让板子复位**，所以 ID 是每次命令行里重新下发的，
> 不会被清掉。灯条那边的配对是存在灯条里的，和板子复位无关。

固件在每条指令执行完之后都会打印一行 `READY`，上位机靠它来判断指令什么时候真的
做完了（而不是靠猜延时）。所以发一个空行就等于 ping，会回一个 `READY`。

### 串口命令行速查

| 命令 | 作用 |
| --- | --- |
| `?` | 帮助 |
| `p` | 打印 nRF24 寄存器配置 |
| `s [秒]` | 扫描遥控器，打印原始 + 解码后的报文 |
| `i <6位十六进制>` | 设置 remote id |
| `o` / `r` | 开/关 / 复位 |
| `u` / `d` | 调亮 / 调暗 |
| `c` / `w` | 变冷 / 变暖 |
| `x <4位十六进制>` | 发送原始命令码 |
| `b <0-15>` / `t <0-15>` | 设置亮度 / 色温绝对值 |
| `a <0\|1>` | 是否四信道广播（默认 1） |
| `n <1-255>` | 每个信道的重复次数（默认 20） |
| `k <0-3>` | 发射功率 MIN / LOW / HIGH / MAX（默认 3 = MAX） |

---

## 网页 GUI（Web Serial）

`docs/index.html` 是一个**单文件、零依赖**的网页 GUI，用浏览器的
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API)
直接开串口 —— **不用装 Python、不用装任何驱动**，插上板子就能点。

界面里能做的事：连接/断开、开/关、亮度滑块、色温滑块（带一个效果预览方块）、
Remote ID 设置、扫描遥控器、一键配对、PA 功率 / 重复次数 / 四信道开关、
发原始命令码、看串口日志。

**打开方式（任选一种）**，都需要桌面版 **Chrome / Edge / Opera**：

1. 直接双击 `docs/index.html`（`file://` 也算安全上下文，可以直接用）。
2. 部署到 GitHub Pages，见下。
3. 本地起服务：`python -m http.server 8000`，然后打开 `http://localhost:8000/docs/`。

> Firefox 和 Safari 都不支持 Web Serial，只能用 Chromium 系浏览器。

### 部署到 GitHub Pages

仓库里已经有 `docs/` 目录和 `docs/.nojekyll`，不需要写 CI，在 GitHub 上点几下就行：

```
Settings → Pages → Source: Deploy from a branch
        → Branch: main  /  (root 改成 /docs)  → Save
```

等一分钟，然后访问 `https://<你的用户名>.github.io/xiaomi-lightbar-1-arduino/`。
Pages 是 HTTPS，满足 Web Serial 的安全上下文要求。

### GUI 测试

串口交互逻辑有一份不需要浏览器的测试，用 mock 串口模拟固件行为，
覆盖连接握手、READY 同步、指令排队、扫描解析、配对循环的启停：

```sh
node tools/gui_test.js      # 18 项检查
```

---

## 编译与烧录

用的是 PlatformIO：

```sh
pio run              # 编译
pio run -t upload    # 烧录
```

`platformio.ini` 里已经为本机写好了 `upload_port = COM42` 和
`upload_speed = 115200`，换电脑的话改掉即可。

如果不想把工具链装到 `~/.platformio`，可以指定一个工程内的 core 目录：

```sh
PLATFORMIO_CORE_DIR="$PWD/.pio-core" pio run -t upload
```

---

## 代码结构

| 文件 | 说明 |
| --- | --- |
| `src/main.cpp` | 串口命令行、扫描模式、各种操作 |
| `lib/radio/radio.cpp` | 射频初始化与自动引脚探测、CRC16、报文构造、收发 |
| `lib/radio/radio.h` | 对外接口与命令码定义 |
| `include/pinout.h` | RF-Nano 各版本引脚说明 |
| `tools/lightbar.py` | 上位机命令行工具（扫描 / 配对 / 发指令） |
| `tools/gui_test.js` | 网页 GUI 的串口逻辑测试（mock 固件） |
| `docs/index.html` | 网页 GUI，可直接开或挂到 GitHub Pages |

---

## 调试经验

- **灯条完全没反应** → 先确认型号是 MJGJD01YL；再确认已经配对成功
  （配对时灯条一定会闪）；最后把板子贴到灯条上重试。
- **`isChipConnected()` 返回 false / 打印 "RADIO NOT DETECTED"** →
  CE/CSN 接法不对。正常会打印 `radio found: CE=D10, CSN=D9`。
- **上传报 `not in sync: resp=0x8e`** → 波特率不对，用 115200。
- **`sent 0/80`** → 射频没配好；`sent 80/80` 只说明 nRF24 把包发出去了，
  不代表灯条收到了。

---

## 致谢

- [lamperez/xiaomi-lightbar-nrf24](https://github.com/lamperez/xiaomi-lightbar-nrf24)
  —— 完整的射频与基带逆向工程，本项目的协议实现全部基于它。
- [nrf24/RF24](https://github.com/nrf24/RF24)
- [emakefun/rf-nano](https://github.com/emakefun/rf-nano)
