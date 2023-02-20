/*
  Warnings:

  - Added the required column `color` to the `FortuneItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "FortuneItem" ADD COLUMN     "color" TEXT NOT NULL;
