//go:build !windows

package main

func (s *server) migrateLoop() {}

func migStatus() any { return nil }
func migrateNow()    {}
