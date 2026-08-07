// Générateur du logo re:cast.
//
// Tout est dessiné à partir des CONTOURS de la police, jamais d'un bitmap
// agrandi : chaque taille est composée pour elle-même, ce qui évite l'escalier
// qu'on voyait sur l'ancienne icône.
//
// Le « : » n'est pas le caractère de la police — la ponctuation est petite par
// construction, et on le veut à la hauteur des capitales. Il est donc dessiné
// en deux carrés, calés sur la hauteur de « RE » et sur la graisse du texte.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class Logo
{
    static readonly Color ROUGE = Color.FromArgb(0xE7, 0x4C, 0x3C);
    const string POLICE = "Segoe UI Black";
    const float EM = 1000f;   // on construit en grand puis on réduit : une
                              // réduction ne révèle jamais de facette

    static FontFamily famille;

    static GraphicsPath Tracer(string texte)
    {
        var p = new GraphicsPath();
        p.AddString(texte, famille, (int)FontStyle.Regular, EM,
                    PointF.Empty, StringFormat.GenericTypographic);
        p.Flatten(new Matrix(), 0.05f);   // bornes d'encre exactes
        return p;
    }

    // Applique échelle + translation pour que l'encre du tracé occupe
    // exactement le rectangle demandé en X, et démarre à `hautY` en Y.
    static void Poser(GraphicsPath p, float gaucheX, float hautY, float echelle)
    {
        var b = p.GetBounds();
        var m = new Matrix();
        m.Translate(gaucheX, hautY);
        m.Scale(echelle, echelle);
        m.Translate(-b.X, -b.Y);
        p.Transform(m);
    }

    static Bitmap Dessiner(int S)
    {
        // Trois compositions selon la place réelle. Vouloir deux lignes dans
        // 16 px donnerait deux bouillies de 7 px : à cette taille l'icône doit
        // se reconnaitre, pas se lire.
        string[] lignes = S >= 40 ? new[] { "RE:", "Cast" }
                        : S >= 24 ? new[] { "RE:" }
                                  : new[] { "R:" };

        var bmp = new Bitmap(S, S, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode     = SmoothingMode.AntiAlias;
            g.PixelOffsetMode   = PixelOffsetMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Color.Transparent);

            // Fond : carré à coins très légèrement adoucis, comme l'actuel.
            float r = Math.Max(1f, S * 0.10f);
            using (var fond = new GraphicsPath())
            {
                fond.AddArc(0, 0, 2 * r, 2 * r, 180, 90);
                fond.AddArc(S - 2 * r, 0, 2 * r, 2 * r, 270, 90);
                fond.AddArc(S - 2 * r, S - 2 * r, 2 * r, 2 * r, 0, 90);
                fond.AddArc(0, S - 2 * r, 2 * r, 2 * r, 90, 90);
                fond.CloseFigure();
                using (var b = new SolidBrush(ROUGE)) g.FillPath(b, fond);
            }

            float largeurCible = S * (lignes.Length == 2 ? 0.78f : 0.72f);
            float gaucheX      = (S - largeurCible) / 2f;
            float interligne   = S * 0.05f;

            // ── Mesures ──────────────────────────────────────────────────────
            var traces   = new List<GraphicsPath>();
            var echelles = new List<float>();
            var hauteurs = new List<float>();
            var pointsColon = new List<bool>();

            foreach (var ligne in lignes)
            {
                bool colon = ligne.EndsWith(":");
                string mot = colon ? ligne.Substring(0, ligne.Length - 1) : ligne;

                var p  = Tracer(mot);
                var b  = p.GetBounds();

                // Le colon dessiné : côté = 32 % de la hauteur des capitales,
                // la paire couvrant toute cette hauteur. Son coût en largeur
                // doit entrer dans l'échelle, sinon la ligne déborderait.
                float cote   = colon ? 0.32f * b.Height : 0f;
                float ecart  = colon ? 0.55f * cote     : 0f;
                float ech    = largeurCible / (b.Width + ecart + cote);

                traces.Add(p);
                echelles.Add(ech);
                hauteurs.Add(b.Height * ech);
                pointsColon.Add(colon);
            }

            float hTotale = 0f;
            foreach (var h in hauteurs) hTotale += h;
            hTotale += interligne * (lignes.Length - 1);
            float y = (S - hTotale) / 2f;

            // ── Tracé ────────────────────────────────────────────────────────
            using (var blanc = new SolidBrush(Color.White))
            {
                for (int i = 0; i < lignes.Length; i++)
                {
                    var p    = traces[i];
                    var b    = p.GetBounds();
                    float ech = echelles[i];
                    float hL  = hauteurs[i];

                    Poser(p, gaucheX, y, ech);
                    g.FillPath(blanc, p);

                    if (pointsColon[i])
                    {
                        float cote  = 0.32f * b.Height * ech;
                        float ecart = 0.55f * cote;
                        float x     = gaucheX + b.Width * ech + ecart;
                        float rc    = cote * 0.18f;   // coins à peine adoucis

                        // Point haut aligné sur le haut des capitales, point bas
                        // sur la ligne de base : le « : » fait toute la hauteur.
                        Carre(g, blanc, x, y,               cote, rc);
                        Carre(g, blanc, x, y + hL - cote,   cote, rc);
                    }

                    y += hL + interligne;
                    p.Dispose();
                }
            }
        }
        return bmp;
    }

    static void Carre(Graphics g, Brush b, float x, float y, float c, float r)
    {
        using (var p = new GraphicsPath())
        {
            p.AddArc(x,             y,             2 * r, 2 * r, 180, 90);
            p.AddArc(x + c - 2 * r, y,             2 * r, 2 * r, 270, 90);
            p.AddArc(x + c - 2 * r, y + c - 2 * r, 2 * r, 2 * r,   0, 90);
            p.AddArc(x,             y + c - 2 * r, 2 * r, 2 * r,  90, 90);
            p.CloseFigure();
            g.FillPath(b, p);
        }
    }

    // ── Écriture du .ico multi-tailles ───────────────────────────────────────
    // System.Drawing.Icon.Save ne sait écrire qu'une seule image et abîme la
    // couche alpha. Le conteneur est donc écrit à la main : Windows choisit
    // alors la taille composée pour le contexte au lieu de rééchantillonner la
    // plus grande.
    //
    // Les petites tailles sont en DIB et non en PNG. Le PNG dans un .ico est
    // légal depuis Vista et l'explorateur le lit très bien, mais la classe
    // System.Drawing.Icon du .NET Framework, elle, lève sur ToBitmap() — donc
    // l'app elle-même n'aurait pas pu charger sa propre icône. Le PNG n'est
    // gardé que pour 128 et 256, où le DIB pèserait 320 Ko à lui seul et où
    // aucun consommateur ancien ne va chercher.
    static void EcrireIco(string chemin, int[] tailles)
    {
        var images = new List<byte[]>();
        foreach (int s in tailles)
            using (var bmp = Dessiner(s))
                images.Add(s >= 128 ? EnPng(bmp) : EnDib(bmp));

        using (var fs = File.Create(chemin))
        using (var w = new BinaryWriter(fs))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)tailles.Length);
            int offset = 6 + 16 * tailles.Length;
            for (int i = 0; i < tailles.Length; i++)
            {
                w.Write((byte)(tailles[i] >= 256 ? 0 : tailles[i]));
                w.Write((byte)(tailles[i] >= 256 ? 0 : tailles[i]));
                w.Write((byte)0); w.Write((byte)0);
                w.Write((short)1); w.Write((short)32);
                w.Write(images[i].Length);
                w.Write(offset);
                offset += images[i].Length;
            }
            foreach (var img in images) w.Write(img);
        }
    }

    static byte[] EnPng(Bitmap bmp)
    {
        using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
    }

    // Entrée DIB d'un .ico : un BITMAPINFOHEADER dont la hauteur est DOUBLÉE
    // (elle couvre l'image puis le masque), les pixels BGRA de bas en haut,
    // puis un masque 1 bit laissé à zéro — la transparence est déjà portée par
    // la couche alpha, mais l'entrée est invalide s'il manque.
    static byte[] EnDib(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        int octetsMasque = ((w + 31) / 32) * 4 * h;
        var sortie = new MemoryStream();
        var e = new BinaryWriter(sortie);

        e.Write(40); e.Write(w); e.Write(h * 2);
        e.Write((short)1); e.Write((short)32);
        e.Write(0); e.Write(w * h * 4);
        e.Write(0); e.Write(0); e.Write(0); e.Write(0);

        var d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly,
                             PixelFormat.Format32bppArgb);
        try
        {
            var ligne = new byte[w * 4];
            for (int y = h - 1; y >= 0; y--)          // bas en haut
            {
                System.Runtime.InteropServices.Marshal.Copy(
                    (IntPtr)(d.Scan0.ToInt64() + (long)y * d.Stride), ligne, 0, ligne.Length);
                e.Write(ligne);
            }
        }
        finally { bmp.UnlockBits(d); }

        e.Write(new byte[octetsMasque]);
        return sortie.ToArray();
    }

    static void EcrirePng(string chemin, int taille)
    {
        using (var bmp = Dessiner(taille)) bmp.Save(chemin, ImageFormat.Png);
    }

    static int Main(string[] args)
    {
        famille = null;
        foreach (var nom in new[] { POLICE, "Arial Black", "Segoe UI" })
            try { famille = new FontFamily(nom); break; } catch { }
        if (famille == null) { Console.Error.WriteLine("aucune police"); return 1; }
        Console.WriteLine("police : " + famille.Name);

        string dossier = args.Length > 0 ? args[0] : ".";
        var tailles = new[] { 16, 20, 24, 32, 48, 64, 128, 256 };
        EcrireIco(Path.Combine(dossier, "icon.ico"), tailles);
        EcrirePng(Path.Combine(dossier, "icon.png"), 256);
        EcrirePng(Path.Combine(dossier, "tray.png"), 32);
        Console.WriteLine("icon.ico (" + tailles.Length + " tailles : "
                          + string.Join(", ", tailles) + "), icon.png, tray.png");
        return 0;
    }
}
