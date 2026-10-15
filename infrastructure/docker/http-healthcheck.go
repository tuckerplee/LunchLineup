package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

// Static GET probe for shell-free images. Usage: http-healthcheck URL
// Exits 0 only when the response status is 200.
func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: http-healthcheck URL")
		os.Exit(2)
	}
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(os.Args[1])
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
