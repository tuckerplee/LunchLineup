#!/bin/bash
# scripts/chaos-experiment.sh
# Chaos engineering experiments.
# Architecture Part IX.

echo "Chaos Experiment: Database Failover Simulation"
# docker compose stop postgres
# sleep 5
# docker compose start postgres

echo "Chaos Experiment: Network Latency Simulation"
# tc qdisc add dev eth0 root netem delay 100ms
# sleep 60
# tc qdisc del dev eth0 root netem
