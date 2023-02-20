/*
  Warnings:

  - You are about to drop the column `color` on the `FortuneItem` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "FortuneItem" DROP COLUMN "color",
ADD COLUMN     "bgcolor" TEXT NOT NULL DEFAULT 'black',
ADD COLUMN     "fgcolor" TEXT NOT NULL DEFAULT 'white';
