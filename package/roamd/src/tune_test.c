/* Host-side checks for tune.c. Not part of the roamd binary. */
#include <stdio.h>
#include <string.h>

#include "tune.h"

static int failed;

static void expect(int cond, const char *msg)
{
	if (cond)
		return;

	fprintf(stderr, "FAIL %s\n", msg);
	failed++;
}

static uint32_t seqn;

static void reset_seq(void)
{
	seqn = 0;
}

static struct tune_event ev_make(uint32_t ts, const char *mac, const char *from,
				 const char *to, uint8_t fb, uint8_t tb, uint8_t type)
{
	struct tune_event e;

	memset(&e, 0, sizeof(e));
	e.ts = ts;
	e.seq = ++seqn;
	snprintf(e.mac, sizeof(e.mac), "%s", mac);
	if (from)
		snprintf(e.from_node, sizeof(e.from_node), "%s", from);
	if (to)
		snprintf(e.to_node, sizeof(e.to_node), "%s", to);
	e.from_band = fb;
	e.to_band = tb;
	e.type = type;

	return e;
}

static void run(const struct tune_event *ev, unsigned int n, struct tune_result *out)
{
	tune_evaluate(ev, n, -55, -82, out);
}

/* Three stays kitchen→hall. The walk back is slower than the move window,
 * so it is not a reverse move. */
static void test_node_ease(void)
{
	struct tune_event ev[16];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(3000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(3001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(4000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(4200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(5001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5300, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 3, "node ease sticky");
	expect(out.pingpong == 0, "node ease pingpong");
	expect(out.node_diff_set, "node ease sets device margin");
	expect(out.node_rssi_diff == 10, "node ease margin 12 -> 10");
	expect(out.rssi_low_set, "node ease sets rssi trigger");
	expect(out.rssi_low == -73, "node ease trigger -75 -> -73");
	expect(!out.band_diff_set, "node ease leaves band margin");
}

/* Two round-trips inside the bounce window raise the device margin. */
static void test_node_pingpong(void)
{
	struct tune_event ev[8];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1100, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1101, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2100, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2101, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.pingpong == 2, "two ping-pongs");
	expect(out.sticky == 0, "ping-pong is not a stay");
	expect(out.node_diff_set, "ping-pong sets device margin");
	expect(out.node_rssi_diff == 14, "ping-pong margin 12 -> 14");
	expect(out.rssi_low == -77, "ping-pong trigger -75 -> -77");
	expect(!out.band_diff_set, "ping-pong leaves band margin");
}

/* One walk back is not enough to raise the saved values. */
static void test_one_bounce(void)
{
	struct tune_event ev[4];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1100, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1101, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.pingpong == 1, "one bounce counted");
	expect(!out.node_diff_set && !out.rssi_low_set && !out.band_diff_set,
	       "one bounce does not move settings");
}

/* Two stays are not enough to lower the bar. */
static void test_two_stays(void)
{
	struct tune_event ev[8];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(3000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(3001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(3400, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 2, "two stays");
	expect(!out.node_diff_set, "two stays do not ease");
}

/* Same node, three stays from 2.4 GHz onto 5 GHz. */
static void test_band_ease(void)
{
	struct tune_event ev[12];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(2000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, mac, "kitchen", "kitchen", 0xff, 0, TUNE_CONNECT);
	ev[n++] = ev_make(3000, mac, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(4000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(4200, mac, "kitchen", "kitchen", 0xff, 0, TUNE_CONNECT);
	ev[n++] = ev_make(5000, mac, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(5300, clock, "kitchen", "kitchen", 0xff, 0, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 3, "band ease sticky");
	expect(out.band_diff_set, "band ease sets band margin");
	expect(out.rssi_diff == 28, "band ease margin 30 -> 28");
	expect(out.rssi_low == -73, "band ease trigger");
	expect(!out.node_diff_set, "band ease leaves device margin");
}

/* Two band round-trips raise the band margin and the RSSI trigger. */
static void test_band_pingpong(void)
{
	struct tune_event ev[4];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(1100, mac, "kitchen", "kitchen", 1, 0, TUNE_ROAM);
	ev[n++] = ev_make(2000, mac, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(2100, mac, "kitchen", "kitchen", 1, 0, TUNE_ROAM);

	run(ev, n, &out);
	expect(out.pingpong == 2, "band ping-pongs");
	expect(out.rssi_diff == 32, "band ping-pong margin 30 -> 32");
	expect(out.rssi_low == -77, "band ping-pong trigger");
	expect(!out.node_diff_set, "band ping-pong leaves device margin");
}

/* A forced disconnect is not a move and not a bounce. */
static void test_kick_ignored(void)
{
	struct tune_event ev[12];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_KICK);
	ev[n++] = ev_make(1001, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1002, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1100, mac, "hall", "hall", 1, 0xff, TUNE_KICK);
	ev[n++] = ev_make(1101, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1102, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_KICK);
	ev[n++] = ev_make(2001, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2002, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2100, mac, "hall", "hall", 1, 0xff, TUNE_KICK);
	ev[n++] = ev_make(2101, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2102, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.moves == 0, "kicks are not moves");
	expect(out.pingpong == 0, "kicks are not ping-pong");
	expect(!out.node_diff_set && !out.rssi_low_set, "kicks do not tune");
}

/* A request the client ignores is a failure and blocks easing. */
static void test_failures_block(void)
{
	struct tune_event ev[16];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(3000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(3001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(4000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(4200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(5001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5400, mac, "kitchen", "kitchen", 1, 0xff, TUNE_STEER);
	ev[n++] = ev_make(5410, mac, "kitchen", "kitchen", 1, 0xff, TUNE_STEER);
	ev[n++] = ev_make(5420, mac, "kitchen", "kitchen", 1, 0xff, TUNE_STEER);
	ev[n++] = ev_make(5600, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 3, "failures still see the stays");
	expect(out.failed == 3, "three ignored requests");
	expect(!out.node_diff_set, "failures block easing");
}

/* Equal stays each way are not a consistently stronger neighbour. */
static void test_balanced(void)
{
	struct tune_event ev[16];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;
	uint32_t t;

	reset_seq();
	for (t = 0; t < 6; t++) {
		const char *from = (t % 2) ? "hall" : "kitchen";
		const char *to = (t % 2) ? "kitchen" : "hall";
		uint32_t at = (t + 1) * 400;

		ev[n++] = ev_make(at, mac, from, from, 1, 0xff, TUNE_DISCONNECT);
		ev[n++] = ev_make(at + 1, mac, to, to, 0xff, 1, TUNE_CONNECT);
	}
	ev[n++] = ev_make(3200, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 6, "balanced stays");
	expect(out.pingpong == 0, "slow returns are not bounces");
	expect(!out.node_diff_set, "no winner, no ease");
}

/* A slight majority toward one neighbour eases by one step. */
static void test_slight_winner(void)
{
	struct tune_event ev[12];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;
	uint32_t t;

	reset_seq();
	for (t = 0; t < 5; t++) {
		const char *from = (t % 2) ? "hall" : "kitchen";
		const char *to = (t % 2) ? "kitchen" : "hall";
		uint32_t at = (t + 1) * 400;

		ev[n++] = ev_make(at, mac, from, from, 1, 0xff, TUNE_DISCONNECT);
		ev[n++] = ev_make(at + 1, mac, to, to, 0xff, 1, TUNE_CONNECT);
	}
	ev[n++] = ev_make(2500, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.sticky == 5, "slight winner stays");
	expect(out.node_rssi_diff == 10, "one winning pair eases one step");
	expect(out.rssi_low == -73, "trigger eases with the margin");
}

/* The same log produces the same targets twice. */
static void test_idempotent(void)
{
	struct tune_event ev[16];
	struct tune_result a, b;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(3000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(3001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(4000, mac, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(4200, mac, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(5001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(5300, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &a);
	run(ev, n, &b);
	expect(a.node_rssi_diff == b.node_rssi_diff && a.rssi_low == b.rssi_low,
	       "second pass matches the first");
}

/* A recent stay is not finished yet. */
static void test_pending(void)
{
	struct tune_event ev[3];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1030, mac, "hall", "hall", 1, 1, TUNE_STEER);

	run(ev, n, &out);
	expect(out.sticky == 0, "recent move is not a stay");
	expect(out.pending > 0, "recent move is pending");
	expect(!out.node_diff_set, "pending does not tune");
}

/* A bounce on one pair and stays on another: the bounce wins the trigger. */
static void test_mixed(void)
{
	struct tune_event ev[20];
	struct tune_result out;
	const char *a = "aa:bb:cc:dd:ee:01";
	const char *b = "aa:bb:cc:dd:ee:02";
	const char *clock = "aa:bb:cc:dd:ee:03";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, a, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1001, a, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1100, a, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1101, a, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2000, a, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2001, a, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(2100, a, "hall", "hall", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2101, a, "kitchen", "kitchen", 0xff, 1, TUNE_CONNECT);

	ev[n++] = ev_make(1000, b, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(2000, b, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(2200, b, "kitchen", "kitchen", 0xff, 0, TUNE_CONNECT);
	ev[n++] = ev_make(3000, b, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(4000, b, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(4200, b, "kitchen", "kitchen", 0xff, 0, TUNE_CONNECT);
	ev[n++] = ev_make(5000, b, "kitchen", "kitchen", 0, 1, TUNE_ROAM);
	ev[n++] = ev_make(5300, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.node_rssi_diff == 14, "mixed raises the device margin");
	expect(out.rssi_diff == 28, "mixed lowers the band margin");
	expect(out.rssi_low == -77, "mixed bounce wins the rssi trigger");
}

/* A request the client follows is not a failure. */
static void test_steer_followed(void)
{
	struct tune_event ev[5];
	struct tune_result out;
	const char *mac = "aa:bb:cc:dd:ee:01";
	const char *clock = "aa:bb:cc:dd:ee:02";
	int n = 0;

	reset_seq();
	ev[n++] = ev_make(1000, mac, "kitchen", "hall", 1, 0xff, TUNE_STEER);
	ev[n++] = ev_make(1010, mac, "kitchen", "kitchen", 1, 0xff, TUNE_DISCONNECT);
	ev[n++] = ev_make(1011, mac, "hall", "hall", 0xff, 1, TUNE_CONNECT);
	ev[n++] = ev_make(1500, clock, "hall", "hall", 0xff, 1, TUNE_CONNECT);

	run(ev, n, &out);
	expect(out.failed == 0, "a followed request is not a failure");
	expect(out.sticky == 1, "the followed move can become a stay");
	expect(!out.node_diff_set, "one stay does not ease");
}

/* Empty log leaves the defaults unset. */
static void test_empty(void)
{
	struct tune_result out;

	run(NULL, 0, &out);
	expect(out.moves == 0 && !out.rssi_low_set && !out.node_diff_set && !out.band_diff_set,
	       "empty log");
}

int main(void)
{
	test_node_ease();
	test_node_pingpong();
	test_one_bounce();
	test_two_stays();
	test_band_ease();
	test_band_pingpong();
	test_kick_ignored();
	test_failures_block();
	test_balanced();
	test_slight_winner();
	test_idempotent();
	test_pending();
	test_mixed();
	test_steer_followed();
	test_empty();

	if (failed) {
		fprintf(stderr, "%d check(s) failed\n", failed);
		return 1;
	}

	printf("tune tests ok\n");

	return 0;
}
