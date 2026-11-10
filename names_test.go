package main

import "testing"

func TestGuessNames(t *testing.T) {
	mk := func(a, b string) *Track { return &Track{nameA: a, nameB: b} }
	tagged := &Track{Artist: "bbno$", Title: "x", tagTitle: true, tagArtist: true}
	cases := []*Track{
		mk("Melanie Martinez", "Alphabet Boy (Official Music Video)"),
		mk("bbno$", "it boy"),
		mk("lalala", "bbno$"),
		mk("Solo", ""),
	}
	guessNames(append([]*Track{tagged}, cases...))
	want := [][2]string{{"Alphabet Boy", "Melanie Martinez"}, {"it boy", "bbno$"}, {"lalala", "bbno$"}, {"Solo", "Artista desconocido"}}
	for i, c := range cases {
		if c.Title != want[i][0] || c.Artist != want[i][1] {
			t.Errorf("%d: got %q / %q, want %q / %q", i, c.Title, c.Artist, want[i][0], want[i][1])
		}
	}
}
