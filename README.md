<a id="ru"></a>

# roamd — бесшовный роуминг Wi-Fi для OpenWrt

**RU** | [EN](#en)

Клиент цепляется за дальнюю точку и не уходит на ближнюю, держит 2,4 ГГц рядом с
пустым 5 ГГц, а при переходе рвёт соединение на несколько секунд. `roamd` чинит это
на стандартном OpenWrt: без `usteer`, `dawn` и правки конфигов руками.

## Что это

Два пакета:

* **`roamd`** — демон на C: band steering, 802.11v BSS Transition Management,
  синхронизация 802.11k Neighbor Report, автонастройка 802.11r.
* **`luci-app-roamd`** — страница настройки в LuCI (**Сеть → Роуминг Wi-Fi**),
  русский перевод — отдельным пакетом `luci-i18n-roamd-ru`.

## Что делает

| Механизм | Назначение |
|---|---|
| Band steering | Не отвечает клиенту в непредпочитаемом диапазоне, пока доступен предпочитаемый |
| 802.11v BTM | Просит подключённого клиента перейти в другой диапазон |
| 802.11k | Точки обмениваются Neighbor Report — клиент находит соседа без полного сканирования |
| 802.11k Beacon Request | Демон просит клиента измерить второй диапазон: решение по реальному RSSI |
| 802.11r | Быстрый переход без повторной аутентификации |
| Мастер настройки | Создаёт готовую сеть с роумингом по имени, шифрованию и паролю |
| Автонастройка | Опции 802.11k/v/r прописываются в `/etc/config/wireless` сами |

Пороги подобраны консервативно: демон вмешивается, только когда переход точно не
ухудшит связь. На вкладке **Параметры переключения** кнопка **Подобрать** читает
журнал переходов и записывает в `/etc/config/roamd` пороги `rssi_low`,
`node_rssi_diff` и `rssi_diff`. Удачные переходы сдвигают пороги к более раннему
переключению. Пинг-понг — клиент ушёл с A на B и вернулся за 180 секунд. Два таких
круга на одной паре поднимают пороги. Одного круга для этого мало. Повторное
нажатие по тому же журналу значения не двигает. Кнопка никого не отключает.

Кроме роуминга внутри одного роутера, `roamd` объединяет несколько устройств OpenWrt
в **Mesh Wi-Fi-систему** — вкладка **MESH** в LuCI: захват устройства из локальной
сети, раскатка профиля на узлы, общая таблица клиентов и журнал переходов. Узел
становится «тупой» точкой доступа в единой подсети — без своего DHCP и NAT, пакеты
на него контроллер ставит сам, под его ветку и архитектуру. Связь узлов — кабелем
или по скрытой беспроводной транспортной сети. Один бинарник совмещает обе роли.

В списке устройств объявленное имя (DHCP или mDNS, поле `host`) стоит над MAC,
написанным мельче. Имени нет — в строке только MAC. Имя, заданное в **Настройках**,
важнее.

На вкладке **Узлы** переключатель **Панель** / **Карта**. Карта — радиальный граф:
контроллер в центре, узлы вокруг, устройства ещё дальше, когда включено
**Показать устройства**. Кабель — сплошная линия, радио — пунктир. На ребре — RSSI,
у кабеля — прочерк.

## Быстрый старт

Нужен OpenWrt **25.12** и два радиоинтерфейса разных диапазонов.
Опубликованы только фиды `feed-25.12-*` репозитория teuchezh/roamd; в них сейчас пакеты
**1.3.0-r1**. Веток 23.05 и 24.10 в релизах нет, установщик их не принимает.
На роутере:

```sh
wget -O - https://raw.githubusercontent.com/teuchezh/roamd/main/install.sh | sh
```

Скрипт проверит, что ветка — 25.12, определит архитектуру, подключит подписанный
репозиторий `https://github.com/teuchezh/roamd/releases/download/feed-25.12-<архитектура>`
и поставит пакеты штатным `apk`. Повторный запуск обновляет до версии, которая лежит в фиде.

Дальше ничего делать не нужно: служба встанет в автозагрузку, параметры 802.11k/v/r
пропишутся сами. Если сеть с одинаковым именем на обоих диапазонах уже настроена,
роуминг заработает сразу. Если нет — **Сеть → Роуминг Wi-Fi**, кнопка
**Создать сеть с роумингом…**.

## Документация

Подробная документация — [docs/README.md](docs/README.md).

## Лицензия

Apache-2.0, см. [LICENSE](LICENSE).

---

<a id="en"></a>

# roamd — seamless Wi-Fi roaming for OpenWrt

[RU](#ru) | **EN**

A client clings to a distant access point instead of moving to the near one, stays on
2.4 GHz next to an idle 5 GHz band, and drops the link for several seconds when it finally
switches. `roamd` fixes that on stock OpenWrt: without `usteer`, `dawn` or hand-edited
configuration files.

## What it is

Two packages:

* **`roamd`** — a daemon written in C: band steering, 802.11v BSS Transition Management,
  802.11k Neighbor Report synchronisation, automatic 802.11r setup.
* **`luci-app-roamd`** — the settings page in LuCI (**Network → Wi-Fi Roaming**);
  the Russian translation ships separately as `luci-i18n-roamd-ru`.

## What it does

| Mechanism | Purpose |
|---|---|
| Band steering | Does not answer a client on the non-preferred band while the preferred one is available |
| 802.11v BTM | Asks a connected client to move to the other band |
| 802.11k | Access points exchange Neighbor Reports — a client finds its neighbour without a full scan |
| 802.11k Beacon Request | The daemon asks the client to measure the other band: the decision is made on real RSSI |
| 802.11r | Fast transition without a full reauthentication |
| Setup wizard | Creates a ready roaming network from a name, an encryption type and a password |
| Automatic configuration | The 802.11k/v/r options are written into `/etc/config/wireless` for you |

Thresholds are deliberately conservative: the daemon steps in only when the transition is
certain not to make the link worse. On the **Switching parameters** tab the **Tune** button
reads the transition log and writes `rssi_low`, `node_rssi_diff` and `rssi_diff` into
`/etc/config/roamd`. Successful moves nudge the thresholds toward an earlier handoff.
A ping-pong is a client going from A to B and back within 180 seconds. Two such round-trips
on the same pair raise the thresholds. One round-trip is not enough to raise them. Pressing
the button again on the same log does not move the values. It does not disconnect anyone.

Beyond roaming inside a single router, `roamd` joins several OpenWrt devices into a
**Mesh Wi-Fi system** — the **MESH** tab in LuCI: capturing a device from the local network,
rolling the profile out to the nodes, a shared client table and a transition log. A node
becomes a dumb access point in one common subnet — with no DHCP or NAT of its own; the
controller installs the packages on it itself, matching the node's branch and architecture.
Nodes are linked by cable or over a hidden wireless backhaul. One binary covers both roles.

In the device list an announced name (DHCP or mDNS, the `host` field) is shown above a
smaller MAC. With no name, the row is the MAC alone. A name set in **Settings** wins.

The **Nodes** tab has a **Cards** / **Map** switch. The map is a radial graph: the controller
in the centre, nodes around it, and clients further out when **Show clients** is on. Cable is
a solid line, radio is dashed, and the edge shows the RSSI or a dash for cable.

## Quick start

You need OpenWrt **25.12** and two radios on different bands.
Only the `feed-25.12-*` feeds of teuchezh/roamd are published; they currently contain
packages **1.3.0-r1**. There are no 23.05 or 24.10 feeds, and the installer rejects those
branches. On the router:

```sh
wget -O - https://raw.githubusercontent.com/teuchezh/roamd/main/install.sh | sh
```

The script checks that the branch is 25.12, detects the architecture, connects the signed
repository `https://github.com/teuchezh/roamd/releases/download/feed-25.12-<architecture>`
and installs the packages with the system's `apk`. Running it again upgrades to whatever
version is in that feed.

Nothing else has to be done: the service is added to autostart and the 802.11k/v/r options
are written on their own. If a network with the same name is already configured on both
bands, roaming starts working right away. If not — **Network → Wi-Fi Roaming**, the
**Create a roaming network…** button.

## Documentation

Full documentation (in Russian) — [docs/README.md](docs/README.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
