# xiaomi-lightbar

[![verified on real hardware](https://img.shields.io/badge/verified-on%20real%20hardware-brightgreen)](#verified)

用一块 **RF-Nano**（板载 nRF24L01+ 的 Arduino Nano）控制 **小米显示器挂灯 MJGJD01YL**。

这是 [benallen-dev/xiaomi-lightbar](https://github.com/benallen-dev/xiaomi-lightbar) 的 fork。
原来的版本只是「把原作者自己遥控器抓到的 5 个报文硬编码回放」，换一台灯就
不可能工作。这里改成了按照 [lamperez 的逆向工程](https://github.com/lamperez/xiaomi-lightbar-nrf24)
**在单片机上实时构造合法报文**（含 CRC16），所以可以控制任意一台 MJGJD01YL。

## Verified

✅ **已在真实硬件上端到端验证** —— 灯条对每一条指令都有反应。

| | |
| :--- | :--- |
| **主控** | RF-Nano V1.0 廉价复刻版（ATmega328P + CH340G），`CE=D10` / `CSN=D9` |
| **灯条** | 小米显示器挂灯 **MJGJD01YL**（非蓝牙版） |
| **实测可用** | 开/关 · 调亮 / 调暗 · 变暖 / 变冷 |
| **另外验证** | 用任意 ID 配对（断电重上电）· 网页刷固件在真机上写入并逐页回读校验 |
| **自动化测试** | 网页 GUI 串口逻辑 19/19 · 亮度/色温刻度与 Python 参考实现逐值一致 · Intel HEX 解析 |

> ⚠️ **MJGJD02YL**（1S，蓝牙版）用不了 —— 它没有 2.4 GHz 接收器。
> 买 nRF24 模块之前先看灯条上的标签。

---

## 🌐 网页控制台

### 👉 <https://wzqvip.github.io/xiaomi-lightbar-1-arduino/>

浏览器直接开串口控制灯条，**不用装 Python、不用装任何驱动**：
开关、亮度、色温、扫描遥控器、一键配对、功率设置、串口日志，全在网页上。

还有 **[网页刷固件](https://wzqvip.github.io/xiaomi-lightbar-1-arduino/flash.html)**
—— 用 Web Serial 直接对 bootloader 讲 STK500 烧录，写完还会逐页回读校验，
同样不需要装 PlatformIO。

> 需要桌面版 **Chrome / Edge / Opera**（Firefox / Safari 不支持 Web Serial）。
> 不想用 Pages 的话，直接双击 `docs/index.html` 也能用。

| 页面 | 作用 |
| --- | --- |
| [`docs/index.html`](docs/index.html) | 控制台：开关 / 亮度 / 色温 / 扫描 / 配对 |
| [`docs/flash.html`](docs/flash.html) | 刷固件，带回读校验 |

---

## 支持的型号（很重要）

| 型号 | 无线方式 | 本方案能否控制 |
| --- | --- | --- |
| **MJGJD01YL** | TLSR8368，2.4G 私有协议 + 旋钮遥控器 | ✅ 可以 |
| MJGJD02YL | ESP32 + 蓝牙（米家 App） | ❌ 不行，需要走蓝牙 |

型号印在灯条本体上。**如果不是 MJGJD01YL，这个项目就不适用。**

---

## 硬件

| 部件 | 型号 |
| --- | --- |
| 主控 | **RF-Nano V1.0/V2.0（廉价复刻版）** |
| 灯条 | 小米显示器挂灯 **MJGJD01YL** |

![RF-Nano V1.0](https://raw.githubusercontent.com/emakefun/rf-nano/master/image/rf-nano_v1.0.png)

*RF-Nano V1.0。图片引用自 [emakefun/rf-nano](https://github.com/emakefun/rf-nano) 官方仓库，版权归原作者。*

### 关于「廉价复刻版」

emakefun 官方 README 自己就写明了：

> rf-nano V1.0 has long been discontinued, but there are still many V1.0-shaped
> boards on the market that are all clone versions with rough workmanship and
> many refurbished materials. The quality is unreliable.

本项目用的就是这样一块板子（V1 外形、Micro USB、CH340G）。**实际影响**：

- **射频性能偏弱**，板载天线是 PCB 蛇形印刷天线，没有外置天线座。
  实测必须**把板子贴到灯条旁边**才稳，放远了就没反应。
- CE/CSN 引脚和标准 nRF24 接法是**反的**（见下）。
- 板子本身功能是好的：SPI、串口、烧录都正常，本项目所有验证都是在这块板上做的。

更多资料：[引脚图](https://raw.githubusercontent.com/emakefun/rf-nano/master/image/rf-nano_pinout.png) ·
[原理图 (V3.0)](https://raw.githubusercontent.com/emakefun/rf-nano/master/schematic/rf-nano_sch_v3.0.pdf) ·
[仓库](https://github.com/emakefun/rf-nano)

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

## 亮度与色温刻度：0–15 到底是多少

灯条（遥控器、射频协议都一样）在亮度和色温上**只有 16 档（0–15）**，而且协议里
没有「设定绝对值」的指令，只能相对增减（所以设绝对值要发两条：先越界饱和，
再退回目标档）。想跟 App 或参数表对照，就得知道每一档是多少。

### 官方参数（用户手册 / mi.com）

| 项目 | 值 |
| --- | --- |
| 型号 | MJGJD01YL |
| 光通量 | **270 lm**（最大） |
| 色温范围 | **2700 K – 6500 K** |
| 显色指数 | Ra95 |
| 额定功率 | 5 W（80 × 0.2 W LED 模组） |
| 寿命 | 25 000 小时 |

> ⚠️ **MJGJD01YL 本身没有 App** —— 它是纯射频遥控器版本。米家 App 里那台是
> **MJGJD02YL（1S，蓝牙版）**，是另一台设备、另一套**连续**刻度，读数不能直接照搬。

### 端点确定，中间档位没有官方说法

2700 K / 6500 K / 270 lm 是官方数据，但**中间 15 档怎么分布小米没有公开**，
几个开源实现也互相不一致，所以下面把三种模型都列出来：

| 模型 | 规则 | 出处 |
| --- | --- | --- |
| `mix`（**默认**） | 在 **mired** 上线性 | ebinf/lightbar2mqtt |
| `kelvin` | 在 **Kelvin** 上线性 | lamperez 的 Home Assistant 集成 |
| `lamperez` | 在 mired 上**分段**线性（153→15、219→7、370→0） | lamperez 的 MQTT 脚本 |

**为什么默认是 `mix`：** 这种灯是在两条 LED 灯珠（一暖一冷）之间调配亮度来改色温的。
两束光合光时是**倒数色温（mired）线性叠加**，Kelvin 不是。所以驱动线性变化时，
线性的是 mired —— `kelvin` 模型在物理上站不住脚。

⚠️ 但这只是**推理，不是实测**。没有色度计就只能到这里；如果你有 App 或仪器读数，
可以用下面的表格反过来校准。

### 完整对照表

| 档位 | 亮度 % | 亮度 lm | 亮度命令 | 色温 K (mix) | mired | 色温 K (kelvin) | 色温 K (lamperez) | 色温命令 |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 0 | 0% | 0 | `0x04F0` → `0x0400` | 2703 | 370 | 2700 | 2703 | `0x02F0` → `0x0200` |
| 1 | 7% | 18 | `0x04F0` → `0x0401` | 2813 | 356 | 2953 | 2870 | `0x02F0` → `0x0201` |
| 2 | 13% | 36 | `0x04F0` → `0x0402` | 2932 | 341 | 3207 | 3059 | `0x02F0` → `0x0202` |
| 3 | 20% | 54 | `0x04F0` → `0x0403` | 3062 | 327 | 3460 | 3276 | `0x02F0` → `0x0203` |
| 4 | 27% | 72 | `0x04F0` → `0x0404` | 3204 | 312 | 3713 | 3525 | `0x02F0` → `0x0204` |
| 5 | 33% | 90 | `0x04F0` → `0x0405` | 3359 | 298 | 3967 | 3815 | `0x02F0` → `0x0205` |
| 6 | 40% | 108 | `0x04F0` → `0x0406` | 3531 | 283 | 4220 | 4157 | `0x02F0` → `0x0206` |
| 7 | 47% | 126 | `0x04F0` → `0x0407` | 3721 | 269 | 4473 | 4566 | `0x02F0` → `0x0207` |
| 8 | 53% | 144 | `0x04F0` → `0x0408` | 3933 | 254 | 4727 | 4745 | `0x02F0` → `0x0208` |
| 9 | 60% | 162 | `0x04F0` → `0x0409` | 4170 | 240 | 4980 | 4938 | `0x02F0` → `0x0209` |
| 10 | 67% | 180 | `0x04F0` → `0x040A` | 4438 | 225 | 5233 | 5148 | `0x02F0` → `0x020A` |
| 11 | 73% | 198 | `0x04F0` → `0x040B` | 4742 | 211 | 5487 | 5376 | `0x02F0` → `0x020B` |
| 12 | 80% | 216 | `0x04F0` → `0x040C` | 5092 | 196 | 5740 | 5626 | `0x02F0` → `0x020C` |
| 13 | 87% | 234 | `0x04F0` → `0x040D` | 5497 | 182 | 5993 | 5900 | `0x02F0` → `0x020D` |
| 14 | 93% | 252 | `0x04F0` → `0x040E` | 5971 | 167 | 6247 | 6202 | `0x02F0` → `0x020E` |
| 15 | 100% | 270 | `0x04F0` → `0x040F` | 6536 | 153 | 6500 | 6536 | `0x02F0` → `0x020F` |

亮度按「线性流明」假设（`lm = 270 × 档位 / 15`）；实测曲线的严格线性同样没有官方依据。

### 生成 / 核对这张表

```sh
python tools/scales.py             # 文本表
python tools/scales.py --markdown  # markdown
python tools/scales.py --json      # JSON，给工具用
```

网页 GUI 里内置了同一套换算（并用 `node tools/gui_test.js` 交叉验证 JS 与 Python
的数值完全一致）：色温卡片上可以直接切换模型，也可以填一个 K 值让滑块跳到最接近的
档位 —— 拿 App 上的读数来对，用的就是这个。

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

仓库里带了 GitHub Actions（`.github/workflows/build.yml`），**不需要手动配置构建**。
只要在仓库设置里选一次：

```
Settings → Pages → Source: GitHub Actions
```

之后每次推到 `main`，CI 都会自动编译固件、跑测试，并把 `docs/`
**连同刚编译出来的 `firmware.hex`** 一起发布到 Pages ——
所以网页刷固件页面拿到的永远是最新构建，不需要手动传文件。

打 tag（比如 `v1.0`）时还会把 `xiaomi-lightbar-rf-nano.hex` / `.elf`
自动挂到 GitHub Release 上。

### 网页刷固件

`docs/flash.html` 用 Web Serial 直接对 Arduino 的 optiboot 讲 **STK500 协议**，
和 `pio run -t upload` 做的是同一件事，但**不需要装任何工具链**：

1. 打开 <https://wzqvip.github.io/xiaomi-lightbar-1-arduino/flash.html>
2. 页面自动读取随 Pages 一起发布的 `firmware.hex`，并显示它的 SHA-256
3. 点「选择串口并烧录」，选 COM42

写入之后会**逐页回读校验**，确认无误才退出 bootloader。也可以选本地 `.hex`
刷自己编译的版本。

> **刷之前先在控制台点「断开」** —— 串口是独占的，两边同时开着一个都连不上。
> 中途失败也不用慌：bootloader 在受保护区域，板子刷不坏，重新插拔 USB 再刷一次即可。

这套 STK500 实现做过**真实端到端验证** —— `tools/flash_test.js` 通过一个
pyserial 桥接，用**和浏览器完全相同的那份 `docs/flasher.js`** 去刷真板子：

```sh
node tools/flash_test.js COM42
```

### 测试

```sh
python tools/scales.py           # 打印刻度换算表
node tools/gui_test.js           # 19 项检查：串口逻辑 + 刻度交叉验证
node tools/flash_test.js COM42   # 真机刷固件（需要接着板子）
```

`gui_test.js` 用 mock 串口模拟固件，覆盖连接握手、READY 同步、指令排队、
扫描解析、配对循环启停，并逐个比对 JS 与 Python 的刻度数值是否一致。
CI 里会跑前两个（不需要硬件）。

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

**不想装工具链**的话，直接用[网页刷固件](https://wzqvip.github.io/xiaomi-lightbar-1-arduino/flash.html)，
或者从 [Releases](https://github.com/wzqvip/xiaomi-lightbar-1-arduino/releases)
下载编译好的 `.hex`，用网页刷进去。

---

## 代码结构

| 文件 | 说明 |
| --- | --- |
| `src/main.cpp` | 串口命令行、扫描模式、各种操作 |
| `lib/radio/radio.cpp` | 射频初始化与自动引脚探测、CRC16、报文构造、收发 |
| `lib/radio/radio.h` | 对外接口与命令码定义 |
| `include/pinout.h` | RF-Nano 各版本引脚说明 |
| `docs/index.html` | 网页控制台 |
| `docs/flash.html` | 网页刷固件页面 |
| `docs/flasher.js` | Intel HEX 解析 + STK500 烧录（浏览器和 Node 共用） |
| `tools/lightbar.py` | 上位机命令行工具（扫描 / 配对 / 发指令） |
| `tools/scales.py` | 亮度 / 色温 0–15 档位与 K、lm、mired 的换算（三种模型） |
| `tools/gui_test.js` | 网页 GUI 的串口逻辑测试（mock 固件）+ 刻度交叉验证 |
| `tools/flash_test.js` | 真机端到端烧录测试 |
| `tools/serial_bridge.py` | 给上面那个测试用的串口桥接 |
| `.github/workflows/build.yml` | CI：编译、测试、发 Pages、发 Release |

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
