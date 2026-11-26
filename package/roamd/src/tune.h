#ifndef ROAMD_TUNE_H
#define ROAMD_TUNE_H

#include <stdbool.h>
#include <stdint.h>

/*
 * One pass over the transition log. Not a timer and not a kick.
 *
 * A place is another node, or another band of the same node.
 * A move is a client changing place. A kick (forced disconnect) is ignored,
 * so it never counts as a success and never counts as a bounce.
 *
 * A ping-pong is one client moving A→B and back to A, with the return
 * finished within TUNE_PINGPONG_WINDOW seconds of the arrival at B.
 * Two such round-trips on the same pair raise the thresholds. One round-trip
 * is remembered but does not move the saved values: a person can walk back once.
 *
 * A stay is a move that is not reversed within that window. The client is
 * still on the new place TUNE_PINGPONG_WINDOW seconds later (the next event
 * in the log, or the newest event in the log when nothing follows).
 *
 * A failed request is a steer with no matching soft move off that node within
 * TUNE_STEER_WINDOW seconds, once the log extends at least that far past it.
 *
 * Where one direction has at least TUNE_STICKY_MIN stays, more stays than the
 * opposite direction, no ping-pong, and fewer failed requests than stays, the
 * neighbour is the one clients keep and the moves succeed. That pair eases
 * the thresholds so the next handoff can start earlier. Ping-pong raises them.
 *
 * Easing lowers the required margins (node_rssi_diff, rssi_diff). The RSSI
 * trigger is rssi_low: easing moves it toward zero (for example -75 → -73)
 * so a client becomes a candidate while the link is still stronger. Raising
 * on ping-pong moves rssi_low the other way and increases the margins.
 * The targets are computed from the built-in defaults, so the same log does
 * not walk the values further on a second press.
 */

#define TUNE_NAME_MAX		64
#define TUNE_MAC_MAX		18
#define TUNE_EVENT_MAX		200
#define TUNE_PAIR_MAX		48

#define TUNE_CONNECT		0
#define TUNE_DISCONNECT		1
#define TUNE_ROAM		2
#define TUNE_STEER		3
#define TUNE_KICK		4

#define TUNE_BAND_NA		0xff
#define TUNE_KIND_NODE		0
#define TUNE_KIND_BAND		1

#define TUNE_MOVE_WINDOW	45
#define TUNE_STEER_WINDOW	45
#define TUNE_PINGPONG_WINDOW	180
#define TUNE_KICK_WINDOW	45

#define TUNE_STICKY_MIN		3
#define TUNE_PINGPONG_MIN	2
#define TUNE_MAX_STEPS		3
#define TUNE_STEP_DB		2

#define TUNE_RSSI_LOW_DEFAULT	-75
#define TUNE_NODE_DIFF_DEFAULT	12
#define TUNE_BAND_DIFF_DEFAULT	30

#define TUNE_RSSI_LOW_MIN	-85
#define TUNE_RSSI_LOW_MAX	-65
#define TUNE_NODE_DIFF_MIN	6
#define TUNE_NODE_DIFF_MAX	24
#define TUNE_BAND_DIFF_MIN	20
#define TUNE_BAND_DIFF_MAX	40

enum tune_action {
	TUNE_NONE = 0,
	TUNE_EASE,
	TUNE_TIGHTEN
};

struct tune_event {
	uint32_t ts;
	uint32_t seq;
	char mac[TUNE_MAC_MAX];
	char from_node[TUNE_NAME_MAX];
	char to_node[TUNE_NAME_MAX];
	uint8_t from_band;
	uint8_t to_band;
	uint8_t type;
};

struct tune_pair_result {
	char a[TUNE_NAME_MAX];
	char b[TUNE_NAME_MAX];
	uint8_t kind;
	uint8_t band_a;
	uint8_t band_b;
	int sticky_ab;
	int sticky_ba;
	int pingpong;
	int action;
};

struct tune_result {
	int rssi_low;
	int node_rssi_diff;
	int rssi_diff;
	bool rssi_low_set;
	bool node_diff_set;
	bool band_diff_set;
	int moves;
	int sticky;
	int failed;
	int pingpong;
	int pending;
	int n_pairs;
	struct tune_pair_result pairs[TUNE_PAIR_MAX];
};

struct blob_buf;

void tune_evaluate(const struct tune_event *ev, unsigned int n,
		   int rssi_good, int kick_rssi, struct tune_result *out);
void roam_tune_apply(struct blob_buf *reply);

#endif
